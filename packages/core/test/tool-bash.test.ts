import fs from "fs/promises"
import { realpathSync } from "node:fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { derive } from "@zaovra-ai/core/session/outcome"
import { toLLMMessages } from "@zaovra-ai/core/session/runner/to-llm-message"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { Model } from "@zaovra-ai/llm"
import { route } from "@zaovra-ai/llm/protocols/openai-chat"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { EventV2 } from "@zaovra-ai/core/event"
import { Config } from "@zaovra-ai/core/config"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Location } from "@zaovra-ai/core/location"
import { LocationMutation } from "@zaovra-ai/core/location-mutation"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { AppProcess } from "@zaovra-ai/core/process"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { BashTool } from "@zaovra-ai/core/tool/bash"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { ToolOutputStore } from "@zaovra-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_bash_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const progress: Array<{ readonly type: string; readonly data: unknown }> = []
const runs: Array<{
  readonly command: string
  readonly cwd?: string
  readonly shell?: string | boolean
  readonly options?: AppProcess.RunOptions
}> = []
let denyAction: string | undefined
let result: AppProcess.RunResult = {
  command: "mock",
  exitCode: 0,
  output: Buffer.from("hello\n"),
  stdout: Buffer.from("hello\n"),
  stderr: Buffer.alloc(0),
  outputTruncated: false,
  stdoutTruncated: false,
  stderrTruncated: false,
}
let runFailure: AppProcess.AppProcessError | undefined
let afterPermission = (_input: PermissionV2.AssertInput): Effect.Effect<void> => Effect.void

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(Effect.suspend(() => afterPermission(input))),
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    run: (command: ChildProcess.Command, options?: AppProcess.RunOptions) =>
      Effect.suspend(() => {
        if (command._tag !== "StandardCommand") throw new Error("expected standard command")
        runs.push({ command: command.command, cwd: command.options.cwd, shell: command.options.shell, options })
        return runFailure ? Effect.fail(runFailure) : Effect.succeed(result)
      }),
  } as unknown as AppProcess.Interface),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
  }),
)

const reset = () => {
  assertions.length = 0
  progress.length = 0
  runs.length = 0
  denyAction = undefined
  runFailure = undefined
  afterPermission = () => Effect.void
  result = {
    command: "mock",
    exitCode: 0,
    output: Buffer.from("hello\n"),
    stdout: Buffer.from("hello\n"),
    stderr: Buffer.alloc(0),
    outputTruncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

const withTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  processLayer: Layer.Layer<AppProcess.Service> = appProcess,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, BashTool.node]),
        [
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [AppProcess.node, processLayer],
          [Config.node, config],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          [
            EventV2.node,
            Layer.mock(EventV2.Service, {
              listen: () => Effect.succeed(Effect.void),
              recentAfter: () => ({ events: [], complete: false }),
              publish: (definition, data) =>
                Effect.sync(() => {
                  progress.push({ type: definition.type, data })
                  return { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
                }),
            }),
          ],
        ],
      ),
    ),
  )
}

const call = (input: typeof BashTool.Input.Type, id = "call-bash") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "bash", input },
})

const it = testEffect(Layer.empty)

describe("BashTool", () => {
  it.live("marks schema rejection before invoking the process", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          reset()
          const invocation = call({ command: 'Write-Output "report"' })
          const settled = yield* withTool(tmp.path, (registry) =>
            settleTool(registry, {
              ...invocation,
              call: {
                ...invocation.call,
                input: { command: 'Write-Output "report"', verification_report: { checks: [] } },
              },
            }),
          )
          expect(settled.inputRejected).toBe(true)
          expect(settled.result).toMatchObject({ type: "error", value: expect.stringContaining("Invalid tool input:") })
          expect(runs).toHaveLength(0)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  it.live(
    "ordinary test output carries coverage, and weakening a failed assertion cannot certify the requirement",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            reset()
            const source = path.join(tmp.path, "product.mjs")
            const script = path.join(tmp.path, "check.mjs")
            const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`
            const history: SessionMessage.AssistantTool[] = []
            const time = { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) }
            for (const stage of ["broken", "weakened", "fixed"] as const) {
              yield* Effect.promise(() =>
                Bun.write(
                  source,
                  stage === "fixed"
                    ? "export const roundtrip = value => value"
                    : 'export const roundtrip = value => value.replace(/^\\uFEFF/, "")',
                ),
              )
              yield* Effect.promise(() =>
                Bun.write(
                  script,
                  `import assert from 'node:assert/strict'; import { roundtrip } from './product.mjs'; assert.equal(roundtrip('\\uFEFFfirst'), '${stage === "weakened" ? "" : "\\uFEFF"}first'); console.log('ordinary test output: passed')`,
                ),
              )
              const input = {
                command,
                verification: "test" as const,
                verification_targets: [source, script],
                verification_assertions: [script],
                verification_requirements: ["Round trips preserve a leading BOM in field data"],
              }
              const settled = yield* withTool(
                tmp.path,
                (registry) => settleTool(registry, call(input, stage)),
                LayerNode.compile(AppProcess.node),
              )
              const structured = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
                settled.output?.structured,
              )
              const check = Schema.decodeUnknownSync(SessionOutcome.Check)(structured.verification)
              expect(check.exit).toBe(stage === "broken" ? 1 : 0)
              expect(check.requirements).toEqual(input.verification_requirements)
              expect(check.assertions).toHaveLength(1)
              history.push({
                id: stage,
                type: "tool",
                name: "bash",
                time,
                state: { status: "completed", input, content: settled.output?.content ?? [], structured },
              })
              const outcome = derive(
                [
                  SessionMessage.Assistant.make({
                    id: toolIdentity.assistantMessageID,
                    type: "assistant",
                    agent: "build",
                    model: { id: ModelV2.ID.make("offline"), providerID: ProviderV2.ID.make("offline") },
                    finish: "stop",
                    time,
                    content: [...history],
                  }),
                ],
                false,
                undefined,
                check.targets ?? [],
                [],
              )
              expect(outcome.state).toBe(
                stage === "broken" ? "failed" : stage === "weakened" ? "completed_unverified" : "completed_verified",
              )
            }
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
  )

  it.live("rejects compound verification before execution and keeps its scope for a corrected check", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          reset()
          const target = path.join(tmp.path, "source.js")
          yield* Effect.promise(() => Bun.write(target, "ok"))
          const settled = yield* withTool(tmp.path, (registry) =>
            settleTool(
              registry,
              call({ command: "npm test; echo success", verification: "test", verification_targets: [target] }),
            ),
          )
          expect(runs).toHaveLength(0)
          expect(settled.output?.structured).toMatchObject({
            verification: { execution: "not-run", cwd: realpathSync(tmp.path), targets: [{ path: target }] },
          })
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  it.live("retains canonical scope when a missing target prevents execution", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          reset()
          const settled = yield* withTool(tmp.path, (registry) =>
            settleTool(registry, call({ command: "npm run build", verification_targets: ["missing.js"] })),
          )
          expect(runs).toHaveLength(0)
          expect(settled.output?.structured).toMatchObject({
            exit: -1,
            verification: {
              kind: "build",
              execution: "not-run",
              cwd: realpathSync(tmp.path),
              targets: [{ path: path.join(realpathSync(tmp.path), "missing.js"), digest: "" }],
            },
          })
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  for (const scenario of [
    "passed",
    "failed",
    "skipped",
    "nonzero",
    "malformed",
    "malformed-nonzero",
    "changed",
    "duplicate",
  ] as const) {
    it.live(`records real suite output conservatively: ${scenario}`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            reset()
            const script = path.join(tmp.path, "verify.cjs")
            const target = path.join(tmp.path, "game.html")
            yield* Effect.promise(() => Bun.write(target, "initial"))
            yield* Effect.promise(() =>
              Bun.write(
                script,
                `
          const fs = require('fs');
          if (${JSON.stringify(scenario)} === 'changed') fs.writeFileSync(${JSON.stringify(target)}, 'changed');
          const checks = ['syntax','smoke','interaction'].map(kind => ({kind, requirements: ['Empty input and restart behavior'], status: kind === 'interaction' && ['failed','skipped'].includes(${JSON.stringify(scenario)}) ? ${JSON.stringify(scenario)} : 'passed'}));
          if (${JSON.stringify(scenario)} === 'duplicate') checks.push(checks[0]);
          process.stdout.write(${JSON.stringify(scenario)}.startsWith('malformed') ? '14/14 passed' : JSON.stringify({checks}));
          if (${JSON.stringify(scenario)}.includes('nonzero')) process.exitCode = 7;
        `,
              ),
            )
            const settled = yield* withTool(
              tmp.path,
              (registry) =>
                settleTool(
                  registry,
                  call({
                    command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`,
                    verification_report: true,
                    verification_targets: [target, script],
                  }),
                ),
              LayerNode.compile(AppProcess.node),
            )
            const record = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
              settled.output?.structured,
            )
            if (scenario === "malformed-nonzero") {
              const check = Schema.decodeUnknownSync(SessionOutcome.Check)(record.verification)
              expect(check.exit).toBe(7)
              expect(check.execution).toBeUndefined()
              return
            }
            if (scenario === "malformed" || scenario === "duplicate") {
              expect(record).toMatchObject({ verification: { exit: -1, execution: "invalid-report" } })
              expect(record?.verifications).toBeUndefined()
              return
            }
            const checks = Schema.decodeUnknownSync(Schema.Array(SessionOutcome.Check))(record?.verifications)
            expect(checks).toHaveLength(3)
            expect(checks[0].requirements).toEqual(["Empty input and restart behavior"])
            expect(checks.map((check) => check.kind)).toEqual(["syntax", "smoke", "interaction"])
            expect(checks[2].exit).toBe(scenario === "nonzero" ? 7 : scenario === "failed" ? 1 : 0)
            if (scenario === "changed")
              expect(checks[0].targets?.find((file) => file.path.endsWith("game.html"))?.digest).toBe("")
            if (scenario === "skipped") expect(checks[2].targets?.every((file) => file.digest === "")).toBe(true)
            if (scenario === "passed")
              expect(checks.every((check) => check.targets?.every((file) => !!file.digest))).toBe(true)
            const message = SessionMessage.Assistant.make({
              id: toolIdentity.assistantMessageID,
              type: "assistant",
              agent: "build",
              model: { id: ModelV2.ID.make("offline"), providerID: ProviderV2.ID.make("offline") },
              finish: "stop",
              time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
              content: [
                SessionMessage.AssistantTool.make({
                  id: "call-bash",
                  type: "tool",
                  name: "bash",
                  time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
                  state: SessionMessage.ToolStateCompleted.make({
                    status: "completed",
                    input: {},
                    structured: record,
                    content: settled.output?.content ?? [],
                  }),
                }),
              ],
            })
            const outcome = derive([message], false, undefined, checks[0].targets ?? [], [])
            expect(outcome.state).toBe(
              ["failed", "nonzero"].includes(scenario)
                ? "failed"
                : ["skipped", "changed"].includes(scenario)
                  ? "completed_unverified"
                  : "completed_verified",
            )
            const history = toLLMMessages([message], Model.make({ id: "offline", provider: "offline", route }))
            const toolResult = history.at(-1)?.content[0]
            if (toolResult?.type !== "tool-result" || toolResult.result.type !== "content")
              throw new Error("Expected model-facing tool result")
            expect(
              toolResult.result.value.find(
                (part: { type: string; text?: string }) =>
                  part.type === "text" && part.text?.startsWith("Verification record"),
              ),
            ).toMatchObject({ text: expect.stringContaining('"kind":"interaction"') })
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  it.live("preserves real command output and bounded progress when a command times out", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          reset()
          const script = path.join(tmp.path, "timeout.js")
          yield* Effect.promise(() =>
            Bun.write(script, "process.stdout.write('diagnostic before timeout'); setInterval(() => {}, 1000)"),
          )
          const settled = yield* withTool(
            tmp.path,
            (registry) =>
              settleTool(
                registry,
                call({
                  command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`,
                  timeout: 1_000,
                }),
              ),
            LayerNode.compile(AppProcess.node),
          )
          expect(settled.output?.structured).toMatchObject({ timeout: true, truncated: false })
          expect(settled.output?.content[0]).toMatchObject({
            text: expect.stringContaining("diagnostic before timeout"),
          })
          expect(progress).toMatchObject([
            {
              type: "session.next.tool.progress",
              data: { callID: "call-bash", content: [{ text: "diagnostic before timeout" }] },
            },
          ])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps the concrete process failure in model-facing errors", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        runFailure = new AppProcess.AppProcessError({ command: "missing", cause: new Error("spawn ENOENT") })
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "missing" }))).pipe(
          Effect.tap((settled) =>
            Effect.sync(() =>
              expect(settled.result).toMatchObject({
                type: "error",
                value: expect.stringContaining("spawn ENOENT"),
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("registers and returns structured successful output from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const definitions = yield* toolDefinitions(registry)
            expect(definitions.map((tool) => tool.name)).toEqual(["bash", "bash_job"])
            expect(definitions.find((tool) => tool.name === "bash")?.inputSchema).not.toHaveProperty(
              "properties.background",
            )
            expect(definitions.find((tool) => tool.name === "bash")?.inputSchema).not.toHaveProperty(
              "properties.description",
            )
            expect(definitions.find((tool) => tool.name === "bash")?.outputSchema).not.toHaveProperty(
              "properties.output",
            )
            expect(definitions.find((tool) => tool.name === "bash")?.outputSchema).not.toHaveProperty(
              "properties.command",
            )
            expect(definitions.find((tool) => tool.name === "bash")?.outputSchema).not.toHaveProperty("properties.cwd")
            expect(yield* toolDefinitions(registry, [{ action: "bash", resource: "*", effect: "deny" }])).toEqual([])
            expect(yield* settleTool(registry, call({ command: "pwd" }))).toEqual({
              result: {
                type: "content",
                value: [
                  { type: "text", text: "hello\n" },
                  { type: "text", text: "Command exited with code 0." },
                ],
              },
              output: {
                structured: {
                  exit: 0,
                  truncated: false,
                },
                content: [
                  { type: "text", text: "hello\n" },
                  { type: "text", text: "Command exited with code 0." },
                ],
              },
            })
            expect(runs).toMatchObject([
              {
                command: process.platform === "win32" ? AppProcess.resolveShell() : "pwd",
                cwd: realpathSync(tmp.path),
              },
            ])
            expect(runs[0]?.options).toMatchObject({
              combineOutput: true,
              maxOutputBytes: BashTool.MAX_CAPTURE_BYTES,
            })
            expect(assertions).toMatchObject([{ sessionID, action: "bash", resources: ["pwd"], save: ["pwd"] }])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("resolves a relative workdir from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => expect(runs).toMatchObject([{ cwd: realpathSync(path.join(tmp.path, "src")) }])),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects a workdir that stops being a directory during approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const workdir = path.join(tmp.path, "src")
        afterPermission = (input) =>
          input.action === "bash"
            ? Effect.promise(async () => {
                await fs.rm(workdir, { recursive: true })
                await fs.writeFile(workdir, "not a directory")
              }).pipe(Effect.orDie)
            : Effect.void
        return Effect.promise(() => fs.mkdir(workdir)).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => {
              expect(runs).toEqual([])
              expect(assertions.map((input) => input.action)).toEqual(["bash"])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  if (process.platform !== "win32") {
    it.live("executes a real shell command through AppProcess", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withTool(
            tmp.path,
            (registry) => settleTool(registry, call({ command: "printf core-bash" })),
            LayerNode.compile(AppProcess.node),
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.result).toEqual({
                  type: "content",
                  value: [
                    { type: "text", text: "core-bash" },
                    { type: "text", text: "Command exited with code 0." },
                  ],
                })
                expect(settled.output?.structured).toMatchObject({
                  exit: 0,
                })
                expect(settled.output?.structured).not.toHaveProperty("output")
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  it.live("approves an explicit external workdir before bash execution", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        return withTool(active.path, (registry) =>
          executeTool(registry, call({ command: "pwd", workdir: outside.path })),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", "bash"])
              expect(assertions[0]).toMatchObject({
                resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
              })
              expect(runs).toHaveLength(1)
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not execute after external-directory or bash denial", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          reset()
          denyAction = "external_directory"
          yield* withTool(active.path, (registry) =>
            executeTool(registry, call({ command: "pwd", workdir: outside.path })),
          )
          expect(assertions.map((item) => item.action)).toEqual(["external_directory"])
          expect(runs).toEqual([])

          reset()
          denyAction = "bash"
          yield* withTool(active.path, (registry) => executeTool(registry, call({ command: "pwd" })))
          expect(assertions.map((item) => item.action)).toEqual(["bash"])
          expect(runs).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("reports external command arguments as advisory warnings without enforcing approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        denyAction = "external_directory"
        const target = path.join(outside.path, "secret.txt")
        return withTool(active.path, (registry) => settleTool(registry, call({ command: `cat ${target}` }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["bash"])
              expect(runs).toHaveLength(1)
              expect(settled.output?.structured).toMatchObject({
                truncated: false,
              })
              expect(settled.output?.structured).not.toHaveProperty("warnings")
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Warnings:"),
              })
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("keeps non-zero exits useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, exitCode: 7, output: Buffer.from("HEAD full output TAIL") }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "false" }, "call-overflow"))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Command exited with code 7"),
              })
              expect(settled.output?.structured).toMatchObject({
                exit: 7,
                truncated: false,
              })
              expect(settled.output?.content[0]).toEqual({ type: "text", text: "HEAD full output TAIL" })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("surfaces bounded process-capture truncation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        result = { ...result, outputTruncated: true }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "verbose" }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.structured).toMatchObject({ truncated: true })
              expect(settled.output?.content[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining("in-memory preview truncated"),
              })
              expect(settled.output?.structured).not.toHaveProperty("resource")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("returns a useful timeout settlement", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        runFailure = new AppProcess.AppProcessError({ command: "sleep", cause: new Error("Timed out") })
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "sleep 60", timeout: 10 }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Command timed out"),
              })
              expect(settled.output?.structured).toMatchObject({
                timeout: true,
                truncated: false,
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

test("keeps locked deferred parity TODOs visible", async () => {
  const source = await fs.readFile(new URL("../src/tool/bash.ts", import.meta.url), "utf8")
  for (const todo of [
    "Port tree-sitter bash / PowerShell parser-based approval reduction.",
    "Port BashArity reusable command-prefix approvals.",
    "Replace token-based command-argument external-directory advisories with parser-based detection.",
    "Add plugin shell.env environment augmentation once V2 plugin hooks exist.",
    "Persist background job status and define restart recovery before exposing remote observation.",
    "Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.",
    "Revisit binary output handling if stdout/stderr decoding is text-only.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
