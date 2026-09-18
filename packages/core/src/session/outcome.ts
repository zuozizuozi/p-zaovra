export * as SessionOutcome from "./outcome"

import { Schema, Option, DateTime } from "effect"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { SessionMessage } from "./message"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"
import { createHash } from "node:crypto"
import path from "node:path"
import { and, asc, desc, eq, gte } from "drizzle-orm"
import type { Database } from "../database/database"
import type { SessionSchema } from "./schema"
import { SessionMessageTable } from "./sql"

/** Evidence is scoped to the durable user request, not the model's compacted view. */
export const history = (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const user = yield* db
      .select({ seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
      .orderBy(desc(SessionMessageTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), gte(SessionMessageTable.seq, user?.seq ?? 0)))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) =>
      Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
    )
  })

/** Narrow diagnosis of a local inline script that failed to parse before running. */
export function executionIssue(command: string, output: string) {
  if (
    /^(?:node|bun)(?:\s+--input-type=(?:module|commonjs))?\s+(?:-e|--eval)\s+(['"]).*\1\s*$/.test(command) &&
    /^(?:file:\/\/\/[^\r\n]*\/)?\[eval[^\r\n]*\]/m.test(output) &&
    /^SyntaxError:/m.test(output) &&
    !/AssertionError/.test(output)
  )
    return "not-run" as const
}

export function engineeringWork(messages: readonly SessionMessage.Message[]) {
  return messages.some(
    (message) =>
      message.type === "assistant" &&
      message.content.some(
        (part) =>
          part.type === "tool" &&
          !part.provider?.executed &&
          ["write", "edit", "apply_patch", "bash"].includes(part.name),
      ),
  )
}

/** Conservative legacy fallback; new callers explicitly identify assertion inputs. */
export function assertionPath(path: string) {
  return /(?:^|[\\/])(?:tests?|__tests__|fixtures?)[\\/]|(?:^|[\\/])[^\\/]*\.(?:test|spec)\.[^\\/]+$|(?:^|[\\/])(?:verify|check|smoke|acceptance)[^\\/]*\.[^\\/]+$/i.test(
    path,
  )
}

/** Verification records need one exit status, not a shell pipeline's last exit. */
export function singleCommand(command: string) {
  let quote = ""
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (char === "`" || (char === "\\" && quote === '"')) {
      index++
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (
      /[;|<>\r\n]/.test(char) ||
      (char === "&" && command.slice(0, index).trim()) ||
      (char === "$" && command[index + 1] === "(")
    )
      return false
  }
  return !quote && !!command.trim() && !command.trimStart().startsWith("{")
}

function rejected(tool: SessionMessage.AssistantTool) {
  return (
    tool.state.status === "error" &&
    (tool.provider?.resultMetadata?.zaovra?.inputRejected === true ||
      /^(?:Invalid tool input:)|No command was executed|Nothing was executed/i.test(tool.state.error.message))
  )
}

/** Hash explicit verification inputs; missing/unreadable files invalidate old evidence. */
export const fingerprint = (fs: FSUtil.Interface, paths: readonly string[]) =>
  Effect.gen(function* () {
    return yield* Effect.forEach([...new Set(paths)], (path) =>
      Effect.gen(function* () {
        const info = yield* fs.stat(path)
        if (info.type !== "File" || info.size > 64 * 1024 * 1024) return { path, digest: "" }
        const bytes = yield* fs.readFile(path)
        return { path, digest: createHash("sha256").update(bytes).digest("hex") }
      }).pipe(Effect.catch(() => Effect.succeed({ path, digest: "" }))),
    )
  })

export const requirements = (fs: FSUtil.Interface, directory: string) =>
  Effect.gen(function* () {
    const text = yield* fs
      .readFileStringSafe(`${directory}/package.json`)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!text) return [] as string[]
    const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
    if (Option.isNone(json)) return [] as string[]
    const manifest = Schema.decodeUnknownOption(
      Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) }),
    )(json.value)
    if (Option.isNone(manifest)) return [] as string[]
    return ["build", "test", "lint", "typecheck"].filter((kind) => kind in manifest.value.scripts)
  })

/** Stable references to the user's actual clauses, not a model-written replacement spec. */
export function requested(messages: readonly SessionMessage.Message[]) {
  const user = messages.findLast((message) => message.type === "user")
  return {
    userMessageID: user?.id,
    clauses:
      user?.text
        .split(/(?<=[。；;\n])/u)
        .map((text) => text.trim())
        .filter(Boolean) ?? [],
  }
}

/** Host-observed execution order. Rejected, timed-out and provider-owned calls are not evidence. */
export function executions(messages: readonly SessionMessage.Message[]) {
  return messages
    .slice(
      Math.max(
        0,
        messages.findLastIndex((message) => message.type === "user"),
      ),
    )
    .flatMap((message) =>
      message.type === "assistant"
        ? message.content.filter(
            (part): part is SessionMessage.AssistantTool => part.type === "tool" && !part.provider?.executed,
          )
        : [],
    )
    .flatMap((part, order) => {
      if (part.state.status !== "completed" || part.state.structured.timeout) return []
      const checks = toolChecks(part)
      if (checks.some((check) => check.execution)) return []
      const exit = part.state.structured.exit ?? checks[0]?.exit
      if (part.name === "bash" && (typeof exit !== "number" || !Number.isFinite(exit))) return []
      return [
        {
          callID: part.id,
          tool: part.name,
          order,
          command: typeof part.state.input.command === "string" ? part.state.input.command : "",
          ...(typeof exit === "number" ? { exit } : {}),
          ...(part.time.ran ? { started: DateTime.toEpochMillis(part.time.ran) } : {}),
          ...(part.time.completed ? { completed: DateTime.toEpochMillis(part.time.completed) } : {}),
        },
      ]
    })
}

export function historicalEvidence(
  reference: { callID: string; exit: number; before?: string },
  observed: ReturnType<typeof executions>,
) {
  const execution = observed.find((entry) => entry.callID === reference.callID)
  if (!execution || execution.tool !== "bash" || execution.exit !== reference.exit) return false
  if (reference.before === undefined) return true
  const before = observed.find((entry) => entry.callID === reference.before)
  return (
    !!before &&
    execution.order < before.order &&
    execution.completed !== undefined &&
    before.started !== undefined &&
    execution.completed <= before.started
  )
}

export function derive(
  messages: readonly SessionMessage.Message[],
  active: boolean,
  snapshot?: string,
  targets: readonly { path: string; digest: string }[] = [],
  required: readonly string[] = ["build", "test", "lint"],
  liveBackgroundShells: ReadonlySet<string> = new Set(),
  directory?: string,
): SessionOutcome.Info {
  const start = messages.findLastIndex((message) => message.type === "user")
  const turn = messages.slice(Math.max(0, start))
  const last = turn.findLast((message) => message.type === "assistant")
  const checks = new Map<string, SessionOutcome.Check>()
  const failedAssertions = new Map<string, { check: SessionOutcome.Check; digest: string }>()
  const fresh = (check: SessionOutcome.Check) =>
    check.targets?.length
      ? check.targets.every(
          (target) =>
            target.digest &&
            targets.some((current) => current.path === target.path && current.digest === target.digest),
        )
      : !!snapshot && check.snapshot === snapshot
  for (const message of turn) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.name !== "bash" || part.provider?.executed) continue
      if (
        (part.state.status === "completed" || part.state.status === "error") &&
        (part.state.input.verification_report === true ||
          (part.state.status === "completed" && Array.isArray(part.state.structured.verifications)))
      ) {
        // A new suite replaces this exact suite's previous coverage. Missing
        // categories must not inherit old passing records.
        for (const [key, check] of checks) {
          if (
            check.exit === 0 &&
            check.command === part.state.input.command &&
            key === checkKey(check, part.state.input)
          )
            checks.delete(key)
        }
      }
      if (part.state.status === "error") {
        const command = typeof part.state.input.command === "string" ? part.state.input.command : ""
        const cwd = directory
          ? path.resolve(directory, typeof part.state.input.workdir === "string" ? part.state.input.workdir : ".")
          : typeof part.state.input.workdir === "string"
            ? part.state.input.workdir
            : undefined
        const kind =
          (part.state.input.verification_report ? "test" : part.state.input.verification) ??
          command.match(/^(?:bun|npm|pnpm|yarn)(?: run)? (build|test|lint|typecheck)(?:\s+[^;&|<>]*)?$/)?.[1]
        const failed = Schema.decodeUnknownOption(SessionOutcome.Check)({
          kind,
          command,
          exit: -1,
          callID: part.id,
          ...(rejected(part)
            ? {
                execution: "not-run",
                ...(cwd ? { cwd } : {}),
                ...(Array.isArray(part.state.input.verification_targets)
                  ? {
                      targets: part.state.input.verification_targets
                        .filter((path): path is string => typeof path === "string")
                        .map((file) => ({ path: cwd ? path.resolve(cwd, file) : file, digest: "" })),
                    }
                  : {}),
              }
            : {}),
        })
        if (Option.isSome(failed)) {
          const key = checkKey(failed.value, part.state.input)
          const previous = checks.get(key)
          checks.set(
            previous?.exit !== 0 && previous && !previous.execution && failed.value.execution
              ? `${key}:${part.id}`
              : key,
            failed.value,
          )
        }
      }
      if (part.state.status !== "completed") continue
      for (const check of toolChecks(part)) {
        if (check.exit !== 0 && !check.execution)
          for (const assertion of check.assertions ??
            check.targets?.filter((target) => assertionPath(target.path)) ??
            [])
            if (assertion.digest && !failedAssertions.has(assertion.path))
              failedAssertions.set(assertion.path, { check, digest: assertion.digest })
        // Release a failed version only after a real rerun passed that exact version.
        // Freshness here is historical: later additions must not undo a proven repair.
        if (check.exit === 0 && !check.execution)
          for (const [file, original] of failedAssertions) {
            if (
              original.check.kind === check.kind &&
              original.check.cwd === check.cwd &&
              (original.check.command === check.command ||
                (Array.isArray(part.state.input.verification_replaces) &&
                  part.state.input.verification_replaces.includes(original.check.callID))) &&
              original.check.targets?.every((target) =>
                check.targets?.some((current) => current.path === target.path && !!current.digest),
              ) &&
              check.assertions?.some((assertion) => assertion.path === file && assertion.digest === original.digest) &&
              check.targets?.some((target) => target.path === file && target.digest === original.digest)
            )
              failedAssertions.delete(file)
          }
        // Only a later, current check in the same category and scope can replace
        // a check that never ran or produced no usable report. Assertion failures
        // require an exact rerun or explicit revalidation with unchanged assertions.
        for (const [key, previous] of checks) {
          if (
            check.exit === 0 &&
            fresh(check) &&
            previous.exit !== 0 &&
            (["not-run", "invalid-report"].includes(previous.execution ?? "") ||
              (!previous.execution &&
                (previous.command === check.command ||
                  (Array.isArray(part.state.input.verification_replaces) &&
                    part.state.input.verification_replaces.includes(previous.callID))) &&
                previous.assertions?.length &&
                previous.assertions.every(
                  (assertion) =>
                    assertion.digest &&
                    check.assertions?.some(
                      (current) => current.path === assertion.path && current.digest === assertion.digest,
                    ),
                ))) &&
            previous.kind === check.kind &&
            previous.cwd &&
            previous.cwd === check.cwd &&
            previous.targets?.length &&
            previous.targets.every((target) => check.targets?.some((current) => current.path === target.path))
          )
            checks.set(key, { ...previous, supersededBy: check.callID })
        }
        const key = checkKey(check, part.state.input)
        const previous = checks.get(key)
        checks.set(
          previous && previous.exit !== 0 && !previous.execution && check.execution ? `${key}:${part.id}` : key,
          { ...check, logs: check.logs ?? part.state.outputPaths ?? [] },
        )
      }
    }
  }
  // A replacement must still exist and pass after later reruns in this history.
  for (const [key, check] of checks) {
    if (
      check.supersededBy &&
      ![...checks.values()].some(
        (current) =>
          current.callID === check.supersededBy && current.kind === check.kind && current.exit === 0 && fresh(current),
      )
    )
      checks.set(key, { ...check, supersededBy: undefined })
  }
  const html = [
    ...new Set(
      [...checks.values()].flatMap(
        (check) => check.targets?.map((target) => target.path).filter((path) => /\.html?$/i.test(path)) ?? [],
      ),
    ),
  ]
  const missing = [
    ...[...failedAssertions].map(([path, original]) =>
      targets.some((target) => target.path === path && target.digest === original.digest)
        ? `Failed assertion not reverified by an unchanged passing execution: ${path}`
        : `Failed assertion changed or unavailable; original requirement not reverified: ${path}`,
    ),
    ...html.flatMap((path) =>
      ["syntax", "smoke", "interaction"]
        .filter(
          (kind) =>
            ![...checks.values()].some(
              (check) =>
                check.kind === kind &&
                check.exit === 0 &&
                fresh(check) &&
                check.targets?.some((target) => target.path === path),
            ),
        )
        .map((kind) => `${kind}: ${path}`),
    ),
    ...required.filter(
      (kind) => ![...checks.values()].some((check) => check.kind === kind && check.exit === 0 && fresh(check)),
    ),
  ]
  // A standalone non-HTML module has no package scripts to enumerate. Its
  // recorded, current test suite is the minimum acceptance evidence; syntax
  // alone is not functional verification. "acceptance" is a missing-evidence
  // label, not a tool check kind the model can register.
  if (
    !required.length &&
    !html.length &&
    ![...checks.values()].some((check) => check.kind === "test" && check.exit === 0 && fresh(check))
  )
    missing.push("acceptance")
  if (
    start >= 0 &&
    engineeringWork(turn) &&
    ![...checks.values()].some(
      (check) => check.exit === 0 && fresh(check) && check.requirements?.some((requirement) => requirement.trim()),
    )
  )
    missing.push("requirements")
  for (const check of checks.values()) {
    if (check.execution && !check.supersededBy && check.exit !== 0)
      missing.push(`${check.execution}: ${check.kind} (${check.callID})`)
  }
  const request = requested(turn)
  const reviews = turn.flatMap((message) =>
    message.type === "assistant"
      ? message.content.flatMap((part) => {
          if (
            part.type !== "tool" ||
            part.name !== "verification_review" ||
            part.provider?.executed ||
            part.state.status !== "completed"
          )
            return []
          const decoded = Schema.decodeUnknownOption(SessionOutcome.Review)(part.state.structured.review)
          return Option.isSome(decoded) && decoded.value.userMessageID === request.userMessageID ? [decoded.value] : []
        })
      : [],
  )
  const review = reviews.at(-1)
  const observed = executions(turn)
  if (turn.some((message) => message.type === "synthetic" && message.text.startsWith("Verification closing review:"))) {
    if (!review) missing.push("requirements review: submit verification_review before claiming completion")
    if (review) {
      for (const [index, clause] of request.clauses.entries()) {
        const items = review.items.filter((item) => item.requirement === index + 1)
        if (
          items.length !== 1 ||
          items[0].status !== "verified" ||
          (items[0].kind === "process" ? !items[0].history?.length : !items[0].evidence.length) ||
          !items[0].evidence.every((id) =>
            [...checks.values()].some(
              (check) => check.callID === id && check.exit === 0 && !check.execution && fresh(check),
            ),
          )
        )
          missing.push(`requirement ${index + 1} unverified: ${clause}`)
        if (items.length === 1)
          missing.push(
            ...items[0].evidence.flatMap((id) => {
              const check = [...checks.values()].find((check) => check.callID === id)
              if (!check)
                return [
                  `requirement ${index + 1}: unknown check callID ${id}; log/event IDs are not verification references`,
                ]
              if (check.exit === 0 && !check.execution && !fresh(check))
                return [`requirement ${index + 1}: stale check ${id}; rerun affected checks and update the review`]
              return []
            }),
          )
        for (const reference of items[0]?.history ?? []) {
          if (!historicalEvidence(reference, observed))
            missing.push(
              `requirement ${index + 1}: invalid historical execution ${reference.callID}; use observed callID, exit and execution order`,
            )
        }
      }
      missing.push(...review.unverified.map((gap) => `declared unverified: ${gap}`))
      // A reference means related context, not an unmet requirement. Clauses and
      // unverified own acceptance; notes cannot erase either or waive failed checks.
      missing.push(
        ...(review.notes ?? [])
          .filter((note) => note.requirements.some((id) => id < 1 || id > request.clauses.length))
          .map((note) => `requirements review: note references unknown requirement (${note.requirements.join(", ")})`),
      )
      if (review.items.some((item) => item.requirement < 1 || item.requirement > request.clauses.length))
        missing.push("requirements review: unknown requirement ID")
    }
  }
  const unknown = turn.some(
    (message) =>
      (message.type === "shell" && message.time.completed === undefined && !liveBackgroundShells.has(message.id)) ||
      (message.type === "assistant" &&
        (message.time.completed === undefined ||
          message.content.some(
            (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
          ))),
  )
  const base = {
    outcomeUnknown: !active && unknown,
    checks: [...checks.values()],
    missing,
    ...(review ? { review } : {}),
    messageID: turn.at(-1)?.id,
  }
  if (active) return { ...base, state: "running" }
  if (unknown || last?.finish === "interrupted") return { ...base, state: "interrupted" }
  if (!last) return { ...base, state: start >= 0 ? "interrupted" : "idle" }
  if (last.error || last.finish !== "stop") return { ...base, state: "failed" }
  if ([...checks.values()].some((check) => check.exit !== 0 && !check.supersededBy && !check.execution))
    return { ...base, state: "failed" }
  return { ...base, state: missing.length ? "completed_unverified" : "completed_verified" }
}

/** Old single-check records and newer suite records share the same check contract. */
export function toolChecks(tool: SessionMessage.AssistantTool): SessionOutcome.Check[] {
  if (tool.name !== "bash" || tool.provider?.executed || tool.state.status !== "completed") return []
  const state = tool.state
  return [
    tool.state.structured.verification,
    ...(Array.isArray(tool.state.structured.verifications) ? tool.state.structured.verifications : []),
  ].flatMap((value) => {
    const check = Schema.decodeUnknownOption(SessionOutcome.Check)(value)
    if (Option.isNone(check) || check.value.callID !== tool.id) return []
    const execution =
      check.value.execution ??
      (check.value.exit !== 0
        ? executionIssue(
            check.value.command,
            state.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
          )
        : undefined)
    // supersededBy is derived by the host, never accepted from a tool report.
    return [{ ...check.value, execution, supersededBy: undefined }]
  })
}

function checkKey(check: SessionOutcome.Check, input: Record<string, unknown>) {
  return JSON.stringify([
    check.kind,
    check.command,
    input.workdir ?? "",
    Array.isArray(input.verification_targets) ? [...input.verification_targets].sort() : [],
  ])
}

export function recoveryFailures(messages: readonly SessionMessage.Message[]) {
  const start = messages.findLastIndex((message) => message.type === "user")
  return messages.slice(Math.max(0, start)).reduce((count, message) => {
    if (message.type !== "assistant") return count
    return message.content.reduce((count, part) => {
      if (part.type !== "tool" || part.provider?.executed) return count
      if (part.name === "bash") {
        if (part.state.status === "error") return rejected(part) ? count : count + 1
        if (part.state.status !== "completed") return count
        const checks = toolChecks(part)
        if (
          checks.length &&
          checks.every(
            (check) =>
              check.execution === "not-run" ||
              (check.execution === "invalid-report" &&
                part.state.status === "completed" &&
                part.state.structured.exit === 0),
          )
        )
          return count
        if (
          part.state.structured.timeout ||
          toolChecks(part).some((check) => check.exit !== 0) ||
          (typeof part.state.structured.exit === "number" && part.state.structured.exit !== 0)
        )
          return count + 1
        return toolChecks(part).some((check) => check.exit === 0) && part.state.structured.exit === 0 ? 0 : count
      }
      return part.state.status === "completed" &&
        ["read", "grep", "glob", "edit", "write", "apply_patch"].includes(part.name)
        ? 0
        : count
    }, count)
  }, 0)
}

/** Durable count, so rebuilding a drain cannot reset automatic correction limits. */
export function inputRejections(messages: readonly SessionMessage.Message[]) {
  return messages
    .slice(
      Math.max(
        0,
        messages.findLastIndex((message) => message.type === "user"),
      ),
    )
    .filter(
      (message) =>
        message.type === "assistant" &&
        message.content.some(
          (part) =>
            part.type === "tool" &&
            part.state.status === "error" &&
            part.provider?.resultMetadata?.zaovra?.inputRejected === true,
        ),
    ).length
}

/** A wholly successful tool turn separates independent correction episodes.
 * A valid sibling in a rejected turn does not reset the limit. Persisted history
 * preserves this boundary across drains; unrelated prose is not progress.
 */
export function consecutiveInputRejections(messages: readonly SessionMessage.Message[]) {
  const turn = messages.slice(
    Math.max(
      0,
      messages.findLastIndex((message) => message.type === "user"),
    ),
  )
  return turn.reduce((count, message) => {
    if (message.type !== "assistant") return count
    if (inputRejections([message])) return count + 1
    const tools = message.content.filter(
      (part): part is SessionMessage.AssistantTool => part.type === "tool" && !part.provider?.executed,
    )
    return tools.length &&
      tools.every(
        (tool) =>
          tool.state.status === "completed" &&
          !tool.state.structured.timeout &&
          (tool.name !== "bash" || tool.state.structured.exit === 0),
      )
      ? 0
      : count
  }, 0)
}
