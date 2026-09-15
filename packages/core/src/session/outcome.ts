export * as SessionOutcome from "./outcome"

import { Schema, Option } from "effect"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { SessionMessage } from "./message"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"
import { createHash } from "node:crypto"

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

export function derive(
  messages: readonly SessionMessage.Message[],
  active: boolean,
  snapshot?: string,
  targets: readonly { path: string; digest: string }[] = [],
  required: readonly string[] = ["build", "test", "lint"],
): SessionOutcome.Info {
  const start = messages.findLastIndex((message) => message.type === "user")
  const turn = messages.slice(Math.max(0, start))
  const last = turn.findLast((message) => message.type === "assistant")
  const checks = new Map<string, SessionOutcome.Check>()
  for (const message of turn) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.name !== "bash" || part.provider?.executed) continue
      if (part.state.status === "error") {
        const command = typeof part.state.input.command === "string" ? part.state.input.command : ""
        const kind =
          part.state.input.verification ??
          command.match(/^(?:bun|npm|pnpm|yarn)(?: run)? (build|test|lint|typecheck)(?:\s+[^;&|<>]*)?$/)?.[1]
        const failed = Schema.decodeUnknownOption(SessionOutcome.Check)({ kind, command, exit: -1, callID: part.id })
        if (Option.isSome(failed)) checks.set(checkKey(failed.value, part.state.input), failed.value)
      }
      if (part.state.status !== "completed") continue
      const value = part.state.structured.verification
      const decoded = Schema.decodeUnknownOption(SessionOutcome.Check)(value)
      if (Option.isSome(decoded) && decoded.value.callID === part.id) {
        const check = decoded.value
        checks.set(checkKey(check, part.state.input), { ...check, logs: check.logs ?? part.state.outputPaths ?? [] })
      }
    }
  }
  const fresh = (check: SessionOutcome.Check) =>
    check.targets?.length
      ? check.targets.every(
          (target) =>
            target.digest &&
            targets.some((current) => current.path === target.path && current.digest === target.digest),
        )
      : !!snapshot && check.snapshot === snapshot
  const html = [
    ...new Set(
      [...checks.values()].flatMap(
        (check) => check.targets?.map((target) => target.path).filter((path) => /\.html?$/i.test(path)) ?? [],
      ),
    ),
  ]
  const missing = html.length
    ? html.flatMap((path) =>
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
      )
    : required.filter(
        (kind) => ![...checks.values()].some((check) => check.kind === kind && check.exit === 0 && fresh(check)),
      )
  if (!required.length && !html.length) missing.push("acceptance")
  const unknown = turn.some(
    (message) =>
      (message.type === "shell" && message.time.completed === undefined) ||
      (message.type === "assistant" &&
        (message.time.completed === undefined ||
          message.content.some(
            (part) => part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"),
          ))),
  )
  const base = { outcomeUnknown: !active && unknown, checks: [...checks.values()], missing, messageID: turn.at(-1)?.id }
  if (active) return { ...base, state: "running" }
  if (unknown || last?.finish === "interrupted") return { ...base, state: "interrupted" }
  if (!last) return { ...base, state: start >= 0 ? "interrupted" : "idle" }
  if (last.error || last.finish !== "stop") return { ...base, state: "failed" }
  if ([...checks.values()].some((check) => check.exit !== 0)) return { ...base, state: "failed" }
  return { ...base, state: missing.length ? "completed_unverified" : "completed_verified" }
}

function checkKey(check: SessionOutcome.Check, input: Record<string, unknown>) {
  return JSON.stringify([check.kind, check.command, input.workdir ?? "", input.verification_targets ?? []])
}

export function recoveryFailures(messages: readonly SessionMessage.Message[]) {
  const start = messages.findLastIndex((message) => message.type === "user")
  return messages.slice(Math.max(0, start)).reduce((count, message) => {
    if (message.type !== "assistant") return count
    return message.content.reduce((count, part) => {
      if (part.type !== "tool" || part.provider?.executed) return count
      if (part.name === "bash") {
        if (part.state.status === "error") return count + 1
        if (part.state.status !== "completed") return count
        if (
          part.state.structured.timeout ||
          (typeof part.state.structured.exit === "number" && part.state.structured.exit !== 0)
        )
          return count + 1
        return part.state.structured.verification && part.state.structured.exit === 0 ? 0 : count
      }
      return part.state.status === "completed" &&
        ["read", "grep", "glob", "edit", "write", "apply_patch"].includes(part.name)
        ? 0
        : count
    }, count)
  }, 0)
}
