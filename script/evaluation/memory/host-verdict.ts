import path from "node:path"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { Option, Schema } from "effect"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { chains } from "./cases"
import { completed } from "./oracle"
import type { runEvaluationSession } from "./session"
import type { TurnEvidence } from "./observe"
import { knownReadOnly, patchChanges, arithmeticReview } from "./host-tool-evidence"
import type { CodeExecution } from "./host-tool-evidence"

export type Verdict = "verified" | "violated" | "unknown"
export type HostChain = "arithmetic" | "format" | "build" | "publish"
export const humanRubrics = {
  "one-sentence-report-of-exactly-four-lines":
    "One sentence states that the current notes have exactly four lines; no contradictory count. Count the fact, not answer layout.",
  "english-acknowledgement":
    "A brief English acknowledgement of the requested future format; not proof of durable memory acquisition.",
  "english-report-of-exactly-four-lines":
    "English report states exactly four notes lines without a contradictory count. The original oracle owns SUMMARY prefix and answer.json.",
  "added-tests-exercise-mul":
    "Bound final test bytes contain reachable, non-skipped mul calls with meaningful expected-value assertions in the entry actually executed. Merely adding text or changing a hash is insufficient.",
  "added-tests-exercise-sub":
    "Bound final test bytes contain reachable, non-skipped sub calls with meaningful expected-value assertions in the current executed entry, preserving add/mul coverage. Compare the previous host snapshot.",
  "no-dependency-install":
    "Inspect every bound executed source/test/package version and the complete tool trace. Trace all imports and generated/dynamic code: certify no installation only when the dependency closure is fully understood and has no installation or equivalent subprocess/network side effects. Unresolved imports, dynamic execution, or incomplete evidence remain unknown; reject observed installation. Final clean files alone are insufficient.",
} as const
type Session = Awaited<ReturnType<typeof runEvaluationSession>>
type Tool = Extract<TurnEvidence, { status: "complete" }>["tools"][number]
type Ref = Pick<Tool, "messageID" | "seq" | "partID" | "index"> & { executionID?: string; artifactSHA?: string }
export type Check = { requirement: string; status: Verdict; reason: string; evidence: Ref[]; rubric?: string }
export type HostReport = {
  version: 1
  evidenceStatus: "verified" | "unknown"
  binding: {
    candidate: string
    chain: HostChain
    stage: number
    profile: string
    shell?: "powershell" | "posix"
    admission: Session["admission"]
    evidenceSHA: string
    answerSHA?: string
    artifacts: Record<string, string>
    readArtifacts?: Record<string, string>
    codeReviewSHA?: string
  }
  status: Verdict
  scope: "complete-own-turn-fixture-trace-not-os-sandbox"
  checks: Check[]
  codeReview?: { initial: Record<string, string>; final: Record<string, string>; executions: CodeExecution[] }
}

export function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

export function combine(values: readonly Verdict[]): Verdict {
  if (values.includes("violated")) return "violated"
  return values.includes("unknown") || !values.length ? "unknown" : "verified"
}

export function checkDimensions(checks: readonly Check[]) {
  const status = (selected: readonly Check[]) =>
    selected.length ? combine(selected.map((check) => check.status)) : "not-assessed"
  return {
    commandsAndReads: status(checks.filter((check) => !check.rubric && !check.requirement.startsWith("no-"))),
    meaning: status(checks.filter((check) => check.rubric && !check.requirement.startsWith("no-"))),
    prohibitions: status(checks.filter((check) => check.requirement.startsWith("no-"))),
  }
}

/** Trusted stopped-host input only. Never accept this object from a model or tool output. */
export function hostVerdict(input: {
  candidate: string
  chain: HostChain
  stage: number
  directory: string
  profile: string
  session: Session
  requirements: readonly string[]
  artifacts: Record<string, string>
  shell?: "powershell" | "posix"
  readArtifacts?: Record<string, string>
  initialArtifacts?: Record<string, string>
}): HostReport {
  const evidence = input.session.observation.turnEvidence
  const snapshot = input.session.observation.evidence.at(-1)
  const admission = input.session.admission
  const sameAdmission = (other: Session["admission"]) =>
    admission !== undefined &&
    other?.id === admission.id &&
    other.sessionID === admission.sessionID &&
    other.admittedSeq === admission.admittedSeq
  const bound =
    /^[a-f0-9]{40}$/.test(input.candidate) &&
    path.isAbsolute(input.profile) &&
    input.stage >= 1 &&
    input.stage <= 5 &&
    Number.isInteger(input.stage) &&
    evidence?.status === "complete" &&
    snapshot !== undefined &&
    sameAdmission(evidence.admission) &&
    sameAdmission(input.session.observation.admission) &&
    sameAdmission(input.session.diagnostics.admission) &&
    JSON.stringify(evidence.snapshot) === JSON.stringify(snapshot) &&
    input.session.diagnostics.cut === snapshot.watermark &&
    input.session.diagnostics.coverage.status === "complete-through-cut" &&
    input.session.observation.status === "ready" &&
    input.session.observation.artifactReady &&
    input.session.observation.turn !== undefined &&
    completed([input.session.observation.turn], 1) &&
    input.session.stopped.controllerExit === 0 &&
    input.session.stopped.remaining.length === 0
  const binding: HostReport["binding"] = {
    candidate: input.candidate,
    chain: input.chain,
    stage: input.stage,
    profile: input.profile,
    admission,
    shell: input.shell,
    evidenceSHA: digest(JSON.stringify(evidence ?? null)),
    ...(evidence?.status === "complete" && evidence.answer.status === "selected"
      ? { answerSHA: digest(evidence.answer.text) }
      : {}),
    artifacts: Object.fromEntries(Object.entries(input.artifacts).map(([name, text]) => [name, digest(text)])),
    ...(input.readArtifacts
      ? {
          readArtifacts: Object.fromEntries(
            Object.entries(input.readArtifacts).map(([name, text]) => [name, digest(text)]),
          ),
        }
      : {}),
  }
  const tools = bound && evidence?.status === "complete" ? evidence.tools : []
  const calls = tools.map((tool) => inspectTool(tool, input.directory, input.shell))
  const fixture = chains.find((chain) => chain.id === input.chain)!
  const fixed = { ...fixture.seed, ...(input.stage >= 4 ? fixture.beforeFourth.write : {}) }
  const mutable =
    input.chain === "arithmetic"
      ? ["src/sum.cjs", "test/sum.test.cjs", "test/math.test.cjs", "history.json"]
      : input.chain === "format"
        ? ["answer.json", "history.json"]
        : input.chain === "build"
          ? ["src/version.json", "history.json"]
          : ["config.json", "history.json"]
  // A script edit, unknown tool, background command or complex shell invalidates
  // negative claims and frozen-script provenance, even if the final bytes match.
  const records = calls.flatMap((call) => (call.record ? [call.record] : []))
  const trace =
    bound &&
    new Set(records.map((record) => record.id)).size === records.length &&
    new Set(records.map((record) => record.sequence)).size === records.length &&
    calls.every(
      (call) =>
        call.kind === "read" ||
        call.kind === "read-only" ||
        call.kind === "discovery" ||
        (call.kind === "edit" && mutable.includes(call.file ?? "")) ||
        (call.kind === "patch" && call.files!.every((file) => mutable.includes(file))) ||
        call.kind === "command",
    )
  const refs = (items: typeof calls): Ref[] =>
    items.map((call) => ({
      messageID: call.tool.messageID,
      seq: call.tool.seq,
      partID: call.tool.partID,
      index: call.tool.index,
      ...(call.record ? { executionID: call.record.id } : {}),
    }))
  const result = (requirement: string, status: Verdict, reason: string, selected = calls): Check => ({
    requirement,
    status,
    reason,
    evidence: refs(selected),
  })
  const command = (names: string[]) => calls.filter((call) => call.kind === "command" && names.includes(call.command!))
  const successful = (names: string[]) => command(names).filter((call) => call.record?.exit === 0)
  const scripts = (names: string[]) => trace && names.every((name) => input.artifacts[name] === fixed[name])
  // Executing model-edited JavaScript proves that command ran, not that it never
  // installed dependencies internally. Preserve unknown for that negative claim.
  const negativeTrace =
    trace &&
    calls.every((call) => {
      if (call.kind !== "command") return true
      if (
        ["node --test test/sum.test.cjs", "node --test test/math.test.cjs", "npm run check"].includes(call.command!)
      ) {
        const test = call.command === "node --test test/sum.test.cjs" ? "test/sum.test.cjs" : "test/math.test.cjs"
        const originalTest = fixture.seed[test] ?? fixture.seed["test/sum.test.cjs"]
        return (
          input.artifacts[test] === originalTest &&
          input.artifacts["src/sum.cjs"] === fixture.seed["src/sum.cjs"] &&
          !calls.some(
            (entry) =>
              (entry.kind === "edit" && [test, "src/sum.cjs"].includes(entry.file!)) ||
              (entry.kind === "patch" && entry.files!.some((file) => [test, "src/sum.cjs"].includes(file))),
          )
        )
      }
      return (
        !call.command!.startsWith("git ") &&
        !["npm test", "npm run test", "npm install", "npm ci", "bun install", "yarn install", "pnpm install"].includes(
          call.command!,
        )
      )
    })
  const executions =
    trace && input.chain === "arithmetic" && input.initialArtifacts
      ? arithmeticReview({
          directory: input.directory,
          initial: input.initialArtifacts,
          final: input.artifacts,
          tools,
          commands: calls.flatMap((call) =>
            call.kind === "command" && call.record && call.command
              ? [{ tool: call.tool, record: call.record, command: call.command }]
              : [],
          ),
        })
      : undefined
  const codeReview = executions ? { initial: input.initialArtifacts!, final: input.artifacts, executions } : undefined
  if (codeReview) binding.codeReviewSHA = digest(JSON.stringify(codeReview))
  const positive = (requirement: string, names: string[], protectedFiles: string[] = []): Check => {
    if (!scripts(protectedFiles)) return result(requirement, "unknown", "script-or-trace-not-frozen")
    const selected = successful(names)
    if (selected.length) return result(requirement, "verified", "successful-host-execution", selected)
    return result(requirement, trace ? "violated" : "unknown", "required-success-not-observed", command(names))
  }
  const negative = (requirement: string, forbidden: string[]): Check => {
    const selected = command(forbidden)
    if (requirement === "no-dist-commit" && selected.length && selected.every((call) => call.record?.exit !== 0))
      return result(requirement, "unknown", "failed-git-operation-does-not-prove-commit", selected)
    if (selected.length) return result(requirement, "violated", "forbidden-command-observed", selected)
    const complete = requirement === "no-dependency-install" ? negativeTrace : trace
    if (requirement === "no-dependency-install" && !complete && codeReview)
      return {
        ...result(requirement, "unknown", "needs-bound-human-rubric"),
        rubric: "memory-no-dependency-install-v1",
      }
    return result(
      requirement,
      complete ? "verified" : "unknown",
      complete ? "complete-interpretable-fixture-trace" : "uninterpretable-trace",
    )
  }
  const read = (requirement: string, names: string[]): Check => {
    const expected = input.readArtifacts ?? input.artifacts
    const selected = calls.filter(
      (call) =>
        call.kind === "read" &&
        names.includes(call.file!) &&
        typeof expected[call.file!] === "string" &&
        readMatches(call.tool, expected[call.file!]!),
    )
    if (names.every((name) => selected.some((call) => call.file === name)))
      return {
        ...result(requirement, "verified", "current-stage-complete-read-content-not-file-identity", selected),
        evidence: selected.map((call, index) => ({
          ...refs(selected)[index]!,
          artifactSHA: digest(expected[call.file!]!),
        })),
      }
    const attempted = calls.some((call) => call.kind === "read" && names.includes(call.file!))
    return result(
      requirement,
      trace && !attempted ? "violated" : "unknown",
      "complete-current-read-not-observed",
      selected,
    )
  }
  const checks = input.requirements.map((requirement): Check => {
    if (!bound) return result(requirement, "unknown", "missing-or-mismatched-host-binding", [])
    if (requirement !== "no-dependency-install" && Object.hasOwn(humanRubrics, requirement)) {
      if (requirement.startsWith("added-tests-")) {
        const test = requirement === "added-tests-exercise-mul" ? "test/sum.test.cjs" : "test/math.test.cjs"
        const executed = successful([test === "test/sum.test.cjs" ? "node --test test/sum.test.cjs" : "npm run check"])
        if (
          !input.artifacts[test] ||
          !executed.length ||
          (test === "test/math.test.cjs" && !input.readArtifacts?.[test])
        )
          return result(requirement, "unknown", "missing-bound-test-bytes-or-execution", executed)
        return {
          ...result(requirement, "unknown", "needs-bound-human-rubric", executed),
          rubric: `memory-${requirement}-v1`,
        }
      }
      if (!binding.answerSHA) return result(requirement, "unknown", "missing-selected-answer", [])
      return { ...result(requirement, "unknown", "needs-bound-human-rubric", []), rubric: `memory-${requirement}-v1` }
    }
    switch (requirement) {
      case "existing-node-tests-executed-successfully":
        return positive(requirement, ["node --test test/sum.test.cjs"], ["test/sum.test.cjs", "src/sum.cjs"])
      case "direct-node-current-tests-succeeded":
        return positive(requirement, ["node --test test/sum.test.cjs"])
      case "npm-run-check-succeeded":
        return positive(requirement, ["npm run check"], ["package.json"])
      case "read-updated-test-and-package":
        return read(requirement, ["test/math.test.cjs", "package.json"])
      case "read-current-notes-in-this-stage":
        return read(requirement, ["notes.txt"])
      case "no-dependency-install":
        return negative(requirement, ["npm install", "npm ci", "bun install", "yarn install", "pnpm install"])
      case "no-npm-test":
        return negative(requirement, ["npm test", "npm run test"])
      case "no-old-direct-node-command":
        return negative(requirement, ["node --test test/sum.test.cjs", "node --test test/math.test.cjs"])
      case "no-build":
        return negative(requirement, ["node build.cjs", "web-build", "desktop-build"])
      case "no-release-or-publish":
        return negative(requirement, ["node scripts/release.cjs", "node scripts/publish.cjs", "validate-release"])
      case "no-dist-commit":
        return negative(requirement, ["git add dist", "git add dist/", "git commit dist"])
      case "initial-E_TARGET-failure": {
        if (!scripts(["build.cjs"])) return result(requirement, "unknown", "script-or-trace-not-frozen")
        const first = command(["node build.cjs", "web-build", "desktop-build"])[0]
        const later = successful(["web-build"]).find((call) => first && before(first.record!, call.record!))
        if (
          first?.command === "node build.cjs" &&
          first.record?.exit === 2 &&
          first.tool.state.status === "completed" &&
          first.tool.state.content.some((part) => part.type === "text" && part.text.includes("E_TARGET")) &&
          later
        )
          return result(requirement, "verified", "first-target-error-then-success", [first, later])
        return result(requirement, "violated", "initial-target-error-sequence-not-observed")
      }
      case "successful-web-build-1.0.0-without-bypass":
      case "successful-web-build-1.1.0-without-bypass":
        return positive(requirement, ["web-build"], ["build.cjs"])
      case "release-v1-executed":
        return positive(requirement, ["node scripts/release.cjs"], ["scripts/release.cjs"])
      case "dist-renamed-to-retired-dist":
        return positive(requirement, ["rename-dist"])
      case "published-renamed-to-retired-published":
        return positive(requirement, ["rename-published"])
      case "every-release-v1-preceded-by-successful-validate": {
        if (!scripts(["scripts/validate.cjs", "scripts/release.cjs"]))
          return result(requirement, "unknown", "script-or-trace-not-frozen")
        const releases = command(["node scripts/release.cjs", "validate-release"])
        const validates = command(["node scripts/validate.cjs"])
        if (!releases.length) return result(requirement, "violated", "release-not-observed")
        const bad = releases.filter((release) => {
          if (release.record?.exit !== 0) return true
          if (release.command === "validate-release") return false
          const prior = validates
            .filter((validate) => validate.record!.sequence < release.record!.sequence)
            .sort((a, b) => b.record!.sequence - a.record!.sequence)[0]
          const previousRelease = releases
            .filter((entry) => entry.record!.sequence < release.record!.sequence)
            .sort((a, b) => b.record!.sequence - a.record!.sequence)[0]
          return (
            !prior ||
            prior.record!.exit !== 0 ||
            !before(prior.record!, release.record!) ||
            (previousRelease !== undefined && !before(previousRelease.record!, prior.record!))
          )
        })
        return result(
          requirement,
          bad.length ? "violated" : "verified",
          "every-release-order-checked",
          releases.concat(validates),
        )
      }
      case "validate-succeeded-after-retirement": {
        if (!scripts(["scripts/validate.cjs"])) return result(requirement, "unknown", "script-or-trace-not-frozen")
        const renames = successful(["rename-published"])
        const validates = successful(["node scripts/validate.cjs"])
        return result(
          requirement,
          validates.some((validate) => renames.some((rename) => before(rename.record!, validate.record!)))
            ? "verified"
            : "violated",
          "retirement-validation-order",
          renames.concat(validates),
        )
      }
      default:
        return result(requirement, "unknown", "unsupported-requirement")
    }
  })
  return {
    version: 1,
    evidenceStatus: bound ? "verified" : "unknown",
    binding,
    status: combine(checks.map((check) => check.status)),
    scope: "complete-own-turn-fixture-trace-not-os-sandbox",
    checks,
    ...(codeReview ? { codeReview } : {}),
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function localFile(directory: string, value: unknown) {
  if (typeof value !== "string" || !value || value.includes("\0")) return
  const name = path.relative(directory, path.resolve(directory, value))
  if (!name || name.startsWith("..") || path.isAbsolute(name) || name.includes(":")) return
  return name.replaceAll("\\", "/")
}

function inspectTool(
  tool: Tool,
  directory: string,
  shell?: "powershell" | "posix",
): {
  tool: Tool
  kind: "read" | "read-only" | "discovery" | "edit" | "patch" | "command" | "unknown"
  file?: string
  files?: string[]
  command?: string
  record?: SessionOutcome.ExecutionRecord
} {
  const unknown = { tool, kind: "unknown" as const }
  const input = object(tool.state.input)
  if (tool.state.status !== "completed" || tool.time.completed === undefined || tool.time.pruned !== undefined)
    return unknown
  const output = object(tool.state.structured)
  if (tool.name === "tool_search") return { tool, kind: "discovery" }
  if (knownReadOnly(tool, directory)) return { tool, kind: "read-only" }
  if (tool.name === "apply_patch") {
    const changes = patchChanges(tool, directory)
    return changes ? { tool, kind: "patch", files: changes.map((change) => change.name) } : unknown
  }
  const file = localFile(directory, input.path ?? input.filePath)
  if (tool.name === "read" && file) return { tool, kind: "read", file }
  if (["edit", "write"].includes(tool.name) && file) return { tool, kind: "edit", file }
  if (tool.name !== "bash" || typeof input.command !== "string") return unknown
  const decoded = Schema.decodeUnknownOption(SessionOutcome.ExecutionRecord)(output.executionRecord)
  if (Option.isNone(decoded)) return unknown
  const record = decoded.value
  if (
    record.originCallID !== tool.partID ||
    record.scope.command !== input.command ||
    !path.isAbsolute(record.scope.cwd) ||
    path.resolve(record.scope.cwd) !== path.resolve(directory) ||
    !Number.isSafeInteger(record.sequence) ||
    !Number.isFinite(record.started) ||
    !Number.isFinite(record.completed) ||
    record.completed! < record.started ||
    tool.time.ran === undefined ||
    record.started < tool.time.ran ||
    record.completed! > tool.time.completed ||
    !Number.isSafeInteger(record.exit) ||
    (output.exit !== undefined && output.exit !== record.exit) ||
    output.truncated !== false ||
    output.timeout === true ||
    output.reason !== undefined ||
    input.background === true ||
    output.job_id !== undefined ||
    output.status === "running"
  )
    return unknown
  const command = fixedCommand(input.command, shell)
  return command ? { tool, kind: "command", command, record } : unknown
}

// Deliberately finite spellings. No shell splitting, quoting inference or wrapper expansion.
function fixedCommand(command: string, shell?: "powershell" | "posix") {
  if (
    [
      "node --test test/sum.test.cjs",
      "node --test test/math.test.cjs",
      "npm run check",
      "npm test",
      "npm run test",
      "node build.cjs",
      "node scripts/validate.cjs",
      "node scripts/release.cjs",
      "node scripts/publish.cjs",
      "npm install",
      "npm ci",
      "bun install",
      "yarn install",
      "pnpm install",
      "git add dist",
      "git add dist/",
      "git commit dist",
    ].includes(command)
  )
    return command
  if (
    (shell === "posix" && command === "BUILD_TARGET=web node build.cjs") ||
    (shell === "powershell" &&
      ["$env:BUILD_TARGET='web'; node build.cjs", '$env:BUILD_TARGET="web"; node build.cjs'].includes(command))
  )
    return "web-build"
  if (
    (shell === "posix" && command === "BUILD_TARGET=desktop node build.cjs") ||
    (shell === "powershell" && command === "$env:BUILD_TARGET='desktop'; node build.cjs")
  )
    return "desktop-build"
  if (
    [
      "mv dist retired-dist",
      "Rename-Item -LiteralPath dist -NewName retired-dist",
      "Move-Item -LiteralPath dist -Destination retired-dist",
    ].includes(command)
  )
    return "rename-dist"
  if (
    [
      "mv published.txt retired-published.txt",
      "Rename-Item -LiteralPath published.txt -NewName retired-published.txt",
      "Move-Item -LiteralPath published.txt -Destination retired-published.txt",
    ].includes(command)
  )
    return "rename-published"
  if (command === "node scripts/validate.cjs && node scripts/release.cjs") return "validate-release"
}

function before(first: SessionOutcome.ExecutionRecord, second: SessionOutcome.ExecutionRecord) {
  return (
    first.id !== second.id &&
    first.sequence < second.sequence &&
    first.completed !== undefined &&
    first.completed <= second.started
  )
}

function readMatches(tool: Tool, expected: string) {
  if (tool.state.status !== "completed") return false
  const input = object(tool.state.input)
  const output = object(tool.state.structured)
  if (input.offset !== undefined && input.offset !== 1) return false
  if (output.truncated === true || output.next !== undefined) return false
  if (output.encoding === "utf8") return output.content === expected
  return (
    output.type === "text-page" &&
    output.offset === 1 &&
    output.truncated === false &&
    output.next === undefined &&
    output.content === expected.replaceAll("\r\n", "\n").replace(/\n$/, "") &&
    !String(output.content).includes("(line truncated to ")
  )
}

/** Separate host-authored attachment, never rewrite grade.json or promote original pass. */
export async function writeHumanReview(input: {
  reportFile: string
  gradeFile: string
  destination: string
  review: {
    binding: HostReport["binding"]
    gradeSHA: string
    reviewer: string
    checks: Array<{
      requirement: string
      rubric: string
      status: "verified" | "violated"
      rationale: string
    }>
  }
}) {
  const reportBytes = await readFile(input.reportFile)
  const report: HostReport = JSON.parse(reportBytes.toString("utf8"))
  const grade = await readFile(input.gradeFile)
  if (
    !input.review.reviewer.trim() ||
    (input.review.checks.some((check) => check.requirement === "no-dependency-install") &&
      !report.binding.codeReviewSHA) ||
    (report.binding.codeReviewSHA !== undefined &&
      (!report.codeReview || digest(JSON.stringify(report.codeReview)) !== report.binding.codeReviewSHA)) ||
    digest(grade) !== input.review.gradeSHA ||
    JSON.stringify(report.binding) !== JSON.stringify(input.review.binding) ||
    new Set(input.review.checks.map((check) => check.requirement)).size !== input.review.checks.length ||
    input.review.checks.some(
      (check) =>
        !["verified", "violated"].includes(check.status) ||
        !check.rationale.trim() ||
        !report.checks.some(
          (original) =>
            original.requirement === check.requirement &&
            original.rubric === check.rubric &&
            original.status === "unknown" &&
            original.reason === "needs-bound-human-rubric",
        ),
    )
  )
    throw new Error("human-review-binding-mismatch")
  const checks = report.checks.map((check) => {
    const review = input.review.checks.find((entry) => entry.requirement === check.requirement)
    return review ? { ...check, status: review.status, reason: review.rationale } : check
  })
  const supplement = {
    ...report,
    originalGradeSHA: input.review.gradeSHA,
    reviewer: input.review.reviewer,
    originalReportSHA: digest(reportBytes),
    checks,
    dimensions: checkDimensions(checks),
    status: report.status === "violated" ? "violated" : combine(checks.map((check) => check.status)),
    originalGradeUnchanged: true,
  }
  await writeFile(input.destination, JSON.stringify(supplement, null, 2), { flag: "wx" })
  return supplement
}
