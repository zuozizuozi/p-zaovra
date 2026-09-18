export * as BashTool from "./bash"

import path from "path"
import { ToolFailure } from "@zaovra-ai/llm"
import { DateTime, Duration, Effect, Layer, Schema, Option } from "effect"
import { Snapshot } from "../snapshot"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { executionIssue, fingerprint, assertionPath, singleCommand } from "../session/outcome"
import { ToolOutputStore } from "../tool-output-store"
import { Config } from "../config"
import { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { BashJob } from "./bash-job"

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_CAPTURE_BYTES = 1024 * 1024

export const Input = Schema.Struct({
  background_kind: Schema.optional(Schema.Literals(["task", "preview"])).annotate({
    description:
      "For background commands only. Use preview only for a local development/preview server: it survives Stop, but is closed on archive or bash_job cancel. Other work defaults to task and stops with execution.",
  }),
  run_in_background: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Start a Session-owned background command; use bash_job to inspect, wait, or cancel it. Preview servers should run in the background without a timeout.",
  }),
  verification: Schema.optional(SessionOutcome.Check.fields.kind).annotate({
    description:
      "Declare a verification command only when executing actual checks. Omit this field for ordinary commands; do not use 'none'. The host records its actual exit and workspace snapshot; this is not a claim that acceptance criteria passed.",
  }),
  verification_report: Schema.optional(Schema.Boolean).annotate({
    description:
      'Legacy compatibility only: leave unset for ordinary checks and prefer verification_requirements. Set true only for an EXISTING runner that already emits only JSON: {"checks":[{"kind":"test","status":"passed","requirements":["User requirement and boundary cases actually asserted"]}]}. Allowed kinds: build, test, lint, typecheck, syntax, smoke, interaction (not acceptance). Each kind occurs once; status is passed, failed or skipped. requirements describes actual assertions against user requirements, not a claim that all work is complete. Include the checked source and test script files in verification_targets. Nonzero exit, malformed/truncated output or changed targets cannot certify success.',
  }),
  verification_requirements: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1)))).annotate({
    description:
      "Preferred: describe requirements actually asserted by this command. Use verification plus verification_targets and verification_assertions. Run a normal command, e.g. npm test; ordinary stdout is accepted. Never put report JSON in command or claim unchecked requirements.",
  }),
  verification_assertions: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Files defining assertions, fixtures and test configuration for this check, relative to workdir or absolute. Include these in verification_targets. The host retains their fingerprints on failures; changing a failed test does not prove the original requirement was fixed.",
  }),
  verification_replaces: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Optional call IDs of previous checks this execution revalidates. The host only resolves failures with the same category, directory and covered targets; actual failures additionally require the original assertion files unchanged. This is not permission to waive a failure.",
  }),
  verification_targets: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Files actually covered by this check, relative to workdir or absolute. Required for standalone/external artifacts. HTML acceptance needs syntax, smoke (actual browser startup), and interaction checks. Do not claim a check without executing assertions; an exit code alone is not proof of functionality.",
  }),
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory. Defaults to the active Location; relative paths resolve from that Location.",
  }),
  timeout: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_TIMEOUT_MS }))
    .pipe(Schema.optional)
    .annotate({
      description: `Timeout in milliseconds, maximum ${MAX_TIMEOUT_MS}. Foreground defaults to ${DEFAULT_TIMEOUT_MS}. Background defaults to no timeout; 0 explicitly selects no timeout for background only.`,
    }),
})

const StructuredOutput = Schema.Struct({
  verification: Schema.optional(SessionOutcome.Check),
  verifications: Schema.optional(Schema.Array(SessionOutcome.Check)),
  job_id: Schema.String.pipe(Schema.optional),
  exit: Schema.Number.pipe(Schema.optional),
  truncated: Schema.Boolean,
  timeout: Schema.Boolean.pipe(Schema.optional),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
})

type Output = typeof Output.Type

const modelOutput = (output: Output) => {
  const warnings = output.warnings?.length
    ? `\n\nWarnings:\n${output.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : ""
  if (output.job_id)
    return `Background command started: ${output.job_id}. Use bash_job to get, wait, or cancel. Completion is recorded in Session history.`
  if (output.timeout) return `${warnings.trimStart()}${warnings ? "\n\n" : ""}Command timed out before completion.`
  if (output.verification?.execution === "not-run")
    return "Verification did not run successfully; inspect the diagnostic and correct its setup."
  return `${warnings.trimStart()}${warnings ? "\n\n" : ""}Command exited with code ${output.exit}.`
}

const isTimeout = (error: AppProcess.AppProcessError) =>
  error.cause instanceof Error && error.cause.message === "Timed out"

/**
 * Minimal V2 core shell boundary. Keep parity debt visible without pulling the
 * legacy shell runtime into core.
 */
// TODO: Port tree-sitter bash / PowerShell parser-based approval reduction.
// TODO: Port BashArity reusable command-prefix approvals.
// TODO: Replace token-based command-argument external-directory advisories with parser-based detection.
// Shell invocation is centralized in AppProcess.shellCommand; preserve its argument boundary.
// TODO: Add plugin shell.env environment augmentation once V2 plugin hooks exist.
// TODO: Persist background job status and define restart recovery before exposing remote observation.
// TODO: Add HTTP background-job observation only after durable status, restart recovery, and authorization are defined.
// TODO: Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.
// TODO: Revisit binary output handling if stdout/stderr decoding is text-only.

const shellTokens = (command: string) => command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2")
const externalCommandDirectories = Effect.fn("BashTool.externalCommandDirectories")(function* (
  fs: FSUtil.Interface,
  command: string,
  cwd: string,
) {
  const directories = new Set<string>()
  for (const token of shellTokens(command)) {
    const value = unquote(token).replace(/[;,|&]+$/, "")
    if (!path.isAbsolute(value)) continue
    const resolved = yield* fs.resolve(value)
    if (FSUtil.contains(cwd, resolved)) continue
    directories.add(yield* fs.resolve(path.dirname(resolved)))
  }
  return [...directories]
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const snapshots = yield* Snapshot.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const jobs = yield* BashJob.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: `Execute one shell command string with the host user's filesystem, process, and network authority. Each call starts a new shell. Set workdir for that call; cd and environment changes do not persist to later calls or change read/write/edit paths. The active Location is the default working directory. Relative workdir values resolve from that Location. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. Timeout values are milliseconds (foreground default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}). Background commands default to no timeout; timeout 0 is supported only in background mode. Uses the configured shell when set; otherwise uses /bin/sh on POSIX and available Windows PowerShell on Windows (cmd fallback). The environment context names the effective shell; use its syntax. Multiline cmd command strings are rejected before execution; write and invoke a script file instead.`,
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({
            ...(output.verification ? { verification: output.verification } : {}),
            ...(output.verifications ? { verifications: output.verifications } : {}),
            truncated: output.truncated,
            ...(output.job_id ? { job_id: output.job_id } : {}),
            ...(output.exit === undefined ? {} : { exit: output.exit }),
            ...(output.timeout === undefined ? {} : { timeout: output.timeout }),
          }),
          toModelOutput: ({ output }) => [
            { type: "text", text: output.output },
            { type: "text", text: modelOutput(output) },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              if (input.background_kind && !input.run_in_background)
                return yield* new ToolFailure({ message: "background_kind requires run_in_background=true" })
              const target = yield* mutation.resolve({ path: input.workdir ?? ".", kind: "directory" })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              const warnings = (yield* externalCommandDirectories(fs, input.command, target.canonical)).map(
                (directory) =>
                  `Command argument references external directory ${path.join(directory, "*").replaceAll("\\", "/")}. Bash runs with host-user filesystem, process, and network authority; this scan is advisory only.`,
              )
              yield* permission.assert({
                action: name,
                resources: [input.command],
                save: [input.command],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })

              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.canonical}`))

              const entries = yield* config.entries()
              const shell = AppProcess.resolveShell(Config.latest(entries, "shell"))
              const command = AppProcess.shellCommand(input.command, target.canonical, shell)
              const timeout = input.timeout ?? (input.run_in_background ? 0 : DEFAULT_TIMEOUT_MS)
              if (timeout === 0 && !input.run_in_background)
                return yield* new ToolFailure({ message: "A zero timeout requires run_in_background=true" })
              let lastProgress = Number.NEGATIVE_INFINITY
              const capture = Option.getOrUndefined(yield* Effect.serviceOption(ToolOutputStore.Capture))
              const inferred = input.command.match(
                /^(?:bun|npm|pnpm|yarn)(?: run)? (build|test|lint|typecheck)(?:\s+[^;&|<>]*)?$/,
              )?.[1]
              const verification = input.verification_report
                ? "test"
                : (input.verification ?? (inferred as "build" | "test" | "lint" | "typecheck" | undefined))
              if (
                input.verification_requirements?.length &&
                (!verification || input.verification_report || !input.verification_targets?.length)
              )
                return yield* new ToolFailure({
                  message:
                    "Coverage requires verification and verification_targets. Test assertions are discovered in standard test directories; declare verification_assertions for custom locations. Omit verification_report; run the ordinary test command. No command was executed.",
                })
              if (input.verification_report && (input.verification || !input.verification_targets?.length))
                return yield* new ToolFailure({
                  message:
                    "A suite report requires explicit verification_targets and cannot be combined with verification. No command was executed.",
                })
              const discovered =
                verification && ["test", "smoke", "interaction"].includes(verification)
                  ? yield* fs.glob("{test,tests,__tests__,fixtures}/**/*", {
                      cwd: target.canonical,
                      absolute: true,
                      include: "file",
                    })
                  : []
              const targets = verification
                ? yield* Effect.forEach(
                    [
                      ...new Set([
                        ...(input.verification_targets ?? []),
                        ...(input.verification_assertions ?? []),
                        ...discovered,
                      ]),
                    ],
                    (file) =>
                      Effect.gen(function* () {
                        const resolved = yield* mutation.resolve({
                          path: path.resolve(target.canonical, file),
                          kind: "file",
                        })
                        if (resolved.externalDirectory)
                          yield* permission.assert({
                            ...LocationMutation.externalDirectoryPermission(resolved.externalDirectory),
                            sessionID: context.sessionID,
                            agent: context.agent,
                            source,
                          })
                        return resolved.canonical
                      }),
                  )
                : []
              if (verification && input.run_in_background)
                return yield* Effect.fail(new Error("Verification must run in the foreground to record its result"))
              const run = Effect.gen(function* () {
                const before = verification ? yield* snapshots.capture() : undefined
                const filesBefore = yield* fingerprint(fs, targets)
                const assertions = filesBefore.filter(
                  (file) =>
                    assertionPath(file.path) ||
                    input.verification_assertions?.some((value) => path.resolve(target.canonical, value) === file.path),
                )
                if (verification && !singleCommand(input.command))
                  return {
                    output:
                      "Verification needs one executable command with its own exit status. Run build and tests separately, without pipes, redirects, chained commands or report JSON as a command. Use a script file for complex assertions. No command was executed.",
                    exit: -1,
                    truncated: false,
                    verification: {
                      kind: verification,
                      command: input.command,
                      exit: -1,
                      execution: "not-run" as const,
                      callID: context.toolCallID,
                      cwd: target.canonical,
                      targets: filesBefore,
                    },
                  }
                if (verification && filesBefore.some((file) => !file.digest))
                  return {
                    output:
                      "Verification target is missing or unreadable. No command was executed. For a build, target existing source inputs; check generated outputs after building.",
                    exit: -1,
                    truncated: false,
                    verification: {
                      kind: verification,
                      command: input.command,
                      exit: -1,
                      execution: "not-run" as const,
                      callID: context.toolCallID,
                      cwd: target.canonical,
                      ...(assertions.length ? { assertions } : {}),
                      ...(input.verification_requirements ? { requirements: input.verification_requirements } : {}),
                      targets: filesBefore,
                    },
                  }
                const result = yield* appProcess
                  .run(command, {
                    combineOutput: true,
                    timeout: timeout === 0 ? undefined : Duration.millis(timeout),
                    maxOutputBytes: MAX_CAPTURE_BYTES,
                    onChunk: capture?.append,
                    onOutput: (output, truncated) =>
                      Effect.gen(function* () {
                        const timestamp = yield* DateTime.now
                        const now = DateTime.toEpochMillis(timestamp)
                        if (input.run_in_background || now - lastProgress < 1_000) return
                        lastProgress = now
                        yield* events.publish(SessionEvent.Tool.Progress, {
                          sessionID: context.sessionID,
                          assistantMessageID: context.assistantMessageID,
                          callID: context.toolCallID,
                          timestamp,
                          structured: { truncated: truncated || output.length > 8_192 },
                          content: [
                            {
                              type: "text",
                              text: output.subarray(Math.max(0, output.length - 8_192)).toString("utf8"),
                            },
                          ],
                        })
                      }),
                  })
                  .pipe(
                    Effect.catchTag("AppProcessError", (error) =>
                      isTimeout(error) ? Effect.succeed(error) : Effect.fail(error),
                    ),
                  )
                if (result instanceof AppProcess.AppProcessError) {
                  return {
                    output: `${result.output || "(no output)"}${result.outputTruncated ? "\n[in-memory preview truncated; consult the command log for captured bytes]" : ""}\nCommand exceeded timeout of ${timeout} ms. Inspect the output before deciding whether to change the command or allow more time.`,
                    truncated: result.outputTruncated === true,
                    timeout: true,
                    ...(verification
                      ? {
                          verification: {
                            kind: verification,
                            command: input.command,
                            exit: -1,
                            execution: "timeout" as const,
                            callID: context.toolCallID,
                          },
                        }
                      : {}),
                    ...(warnings.length ? { warnings } : {}),
                  }
                }

                const output =
                  (result.output?.toString("utf8") || "(no output)") +
                  (verification && !input.verification_report && result.exitCode !== 0 && assertions.length
                    ? `\nFailed assertion files are protected: ${assertions.map((file) => file.path).join(", ")}. Fix implementation and rerun this check with these files UNCHANGED first. Once that exact version passes, new tests can be added normally. Until then put additional tests in separate files. Changing expectations cannot prove a repair.`
                    : "")
                const filesAfter = yield* fingerprint(fs, targets)
                if (verification && capture)
                  yield* capture.append(
                    new TextEncoder().encode(
                      `\nVerification record: ${verification}; exit ${result.exitCode}; cwd ${target.canonical}. This records the command result, not complete task acceptance.\n`,
                    ),
                  )
                const notice = result.outputTruncated
                  ? "[in-memory preview truncated; consult the command log for captured bytes]"
                  : undefined
                const record = verification
                  ? {
                      kind: verification,
                      command: input.command,
                      exit: result.exitCode,
                      ...(assertions.length ? { assertions } : {}),
                      ...(input.verification_requirements ? { requirements: input.verification_requirements } : {}),
                      ...(result.exitCode !== 0 && executionIssue(input.command, output)
                        ? { execution: "not-run" as const }
                        : {}),
                      callID: context.toolCallID,
                      cwd: target.canonical,
                      ...(targets.length
                        ? {
                            targets: filesBefore.map((file) => ({
                              ...file,
                              digest: filesAfter.some(
                                (after) => after.path === file.path && after.digest === file.digest,
                              )
                                ? file.digest
                                : "",
                            })),
                          }
                        : {}),
                      snapshot: !external && before && before === (yield* snapshots.capture()) ? before : undefined,
                    }
                  : undefined
                if (input.verification_report && record) {
                  const report = result.outputTruncated
                    ? Option.none()
                    : Schema.decodeUnknownOption(
                        Schema.fromJsonString(
                          Schema.Struct({
                            checks: Schema.Array(
                              Schema.Struct({
                                kind: SessionOutcome.Check.fields.kind,
                                status: Schema.Literals(["passed", "failed", "skipped"]),
                                requirements: Schema.optional(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
                              }),
                            ),
                          }),
                        ),
                      )(output.trim())
                  if (
                    Option.isNone(report) ||
                    !report.value.checks.length ||
                    new Set(report.value.checks.map((check) => check.kind)).size !== report.value.checks.length ||
                    report.value.checks.every((check) => check.status === "skipped")
                  )
                    return {
                      output: `${output}\nInvalid legacy verification report. Prefer rerunning the ordinary check with verification and verification_requirements, without verification_report; normal stdout is accepted. Existing JSON runners must emit only {"checks":[{"kind":"test","status":"passed"}]} with actual results. Allowed kinds: build, test, lint, typecheck, syntax, smoke, interaction; "acceptance" is not a kind. Status: passed, failed or skipped. Kinds must be distinct. No checks certified.`,
                      exit: result.exitCode,
                      truncated: result.outputTruncated === true,
                      verification: {
                        ...record,
                        exit: result.exitCode || -1,
                        ...(result.exitCode === 0 ? { execution: "invalid-report" as const } : {}),
                      },
                      ...(warnings.length ? { warnings } : {}),
                    }
                  return {
                    output,
                    exit: result.exitCode,
                    truncated: false,
                    // The process result is authoritative even if a reporter says passed.
                    verification: report.value.checks.some((check) => check.status === "skipped")
                      ? {
                          ...record,
                          targets: record.targets?.map((file) => ({ ...file, digest: "" })),
                          snapshot: undefined,
                        }
                      : record,
                    verifications: report.value.checks.map((check) => ({
                      ...record,
                      kind: check.kind,
                      ...(check.requirements ? { requirements: check.requirements } : {}),
                      exit: result.exitCode !== 0 ? result.exitCode : check.status === "passed" ? 0 : 1,
                      ...(check.status === "skipped"
                        ? {
                            exit: result.exitCode,
                            snapshot: undefined,
                            targets: record.targets?.map((file) => ({ ...file, digest: "" })),
                          }
                        : {}),
                    })),
                    ...(warnings.length ? { warnings } : {}),
                  }
                }
                return {
                  ...(record ? { verification: record } : {}),
                  exit: result.exitCode,
                  output: notice ? `${output}\n\n${notice}` : output,
                  truncated: result.outputTruncated === true,
                  ...(warnings.length ? { warnings } : {}),
                }
              })
              if (!input.run_in_background) return yield* run
              const job_id = yield* jobs.start(
                input.command,
                run.pipe(
                  Effect.flatMap((output) => {
                    const text = `${output.output}\n${modelOutput(output)}`
                    return "timeout" in output || output.exit !== 0
                      ? Effect.fail(new Error(text))
                      : Effect.succeed(text)
                  }),
                ),
                context,
                capture ? capture.append(new Uint8Array()) : Effect.void,
                { kind: input.background_kind ?? "task", workdir: target.canonical },
              )
              return { job_id, output: "Command log is retained while the job runs.", truncated: false }
            }).pipe(
              Effect.mapError(
                (error) =>
                  new ToolFailure({
                    message: `Unable to execute command: ${input.command}\n${error instanceof Error ? error.message : String(error)}`,
                  }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/bash",
  layer,
  deps: [
    ToolRegistry.node,
    Snapshot.node,
    BashJob.node,
    LocationMutation.node,
    FSUtil.node,
    AppProcess.node,
    Config.node,
    PermissionV2.node,
    EventV2.node,
  ],
})
