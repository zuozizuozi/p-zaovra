export * as BashTool from "./bash"

import path from "path"
import { ToolFailure } from "@zaovra-ai/llm"
import { DateTime, Duration, Effect, Layer, Schema, Option } from "effect"
import { Snapshot } from "../snapshot"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { fingerprint } from "../session/outcome"
import { ToolOutputStore } from "../tool-output-store"
import { Config } from "../config"
import { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { BashJob } from "./bash-job"

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_CAPTURE_BYTES = 1024 * 1024

export const Input = Schema.Struct({
  run_in_background: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Start a bounded background command; use bash_job to inspect, wait, or cancel it.",
  }),
  verification: Schema.optional(SessionOutcome.Check.fields.kind).annotate({
    description:
      "Declare a build/test/lint/typecheck command. The host records its actual exit and workspace snapshot; this is not a claim that acceptance criteria passed.",
  }),
  verification_targets: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Files actually covered by this check, relative to workdir or absolute. Required for standalone/external artifacts. HTML acceptance needs syntax, smoke (actual browser startup), and interaction checks. Do not claim a check without executing assertions; an exit code alone is not proof of functionality.",
  }),
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory. Defaults to the active Location; relative paths resolve from that Location.",
  }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and may not exceed ${MAX_TIMEOUT_MS}.`,
    }),
})

const StructuredOutput = Schema.Struct({
  verification: Schema.optional(SessionOutcome.Check),
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
          description: `Execute one shell command string with the host user's filesystem, process, and network authority. The active Location is the default working directory. Relative workdir values resolve from that Location. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. Timeout values are milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}). Uses the configured shell when set; otherwise uses /bin/sh on POSIX and available Windows PowerShell on Windows (cmd fallback). The environment context names the effective shell; use its syntax. Multiline cmd command strings are rejected before execution; write and invoke a script file instead.`,
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({
            ...(output.verification ? { verification: output.verification } : {}),
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
              const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
              let lastProgress = Number.NEGATIVE_INFINITY
              const capture = Option.getOrUndefined(yield* Effect.serviceOption(ToolOutputStore.Capture))
              const inferred = input.command.match(
                /^(?:bun|npm|pnpm|yarn)(?: run)? (build|test|lint|typecheck)(?:\s+[^;&|<>]*)?$/,
              )?.[1]
              const verification =
                input.verification ?? (inferred as "build" | "test" | "lint" | "typecheck" | undefined)
              const targets = verification
                ? yield* Effect.forEach(input.verification_targets ?? [], (file) =>
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
                if (filesBefore.some((file) => !file.digest))
                  return yield* Effect.fail(
                    new Error("Verification target is missing or unreadable. No command was executed."),
                  )
                const result = yield* appProcess
                  .run(command, {
                    combineOutput: true,
                    timeout: Duration.millis(timeout),
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
                            callID: context.toolCallID,
                          },
                        }
                      : {}),
                    ...(warnings.length ? { warnings } : {}),
                  }
                }

                const output = result.output?.toString("utf8") || "(no output)"
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
                return {
                  ...(verification
                    ? {
                        verification: {
                          kind: verification,
                          command: input.command,
                          exit: result.exitCode,
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
                        },
                      }
                    : {}),
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
