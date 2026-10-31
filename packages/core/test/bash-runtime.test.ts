import { expect } from "bun:test"
import path from "path"
import { Deferred, Effect, Fiber, Layer, Logger, Schema } from "effect"
import { sql } from "drizzle-orm"
import { adjust } from "effect/testing/TestClock"
import { BashJob } from "@zaovra-ai/core/tool/bash-job"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { ConfigExperimental } from "@zaovra-ai/core/config/experimental"
import { Config } from "@zaovra-ai/core/config"
import { Global } from "@zaovra-ai/core/global"
import { Location } from "@zaovra-ai/core/location"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { BackgroundJob } from "@zaovra-ai/core/background-job"
import { SessionOutcome } from "@zaovra-ai/core/session/outcome"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { DateTime } from "effect"
import { Database } from "@zaovra-ai/core/database/database"
import { EventV2 } from "@zaovra-ai/core/event"
import { SessionInput } from "@zaovra-ai/core/session/input"
import { ExecutionContext } from "@zaovra-ai/core/session/execution-context"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { SessionMessageTable } from "@zaovra-ai/core/session/sql"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { BashTool } from "@zaovra-ai/core/tool/bash"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
for (const foreground of [false, true]) {
  it.live(
    `462 delivered service survives Stop and stops on archive after ${foreground ? "foreground yield" : "background launch"}`,
    () =>
      withRuntime((directory, sessions, registry, jobs) =>
        Effect.gen(function* () {
          const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
          const ready = path.join(directory, "service-ready.json")
          const script = path.join(directory, "service.cjs")
          const log = path.join(directory, "service.log")
          yield* Effect.promise(() =>
            Bun.write(
              script,
              `const s=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('delivered')}); Bun.write(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,port:s.port}));`,
            ),
          )
          const result = yield* settleTool(registry, {
            sessionID: session.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "delivered-service",
              name: "bash",
              input: {
                command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}" > "${log}" 2>&1`,
                background_kind: "preview",
                run_in_background: !foreground,
                timeout: 50,
                workdir: directory,
              },
            },
          })
          const job = (result.output?.structured as { job_id?: string } | undefined)?.job_id
          expect(result.output).toBeDefined()
          expect(job).toBeDefined()
          yield* Effect.gen(function* () {
            yield* Effect.promise(async () => {
              const deadline = Date.now() + 5000
              while (!(await Bun.file(ready).exists())) {
                if (Date.now() >= deadline)
                  throw new Error(
                    `Delivered service did not listen: ${await Bun.file(log)
                      .text()
                      .catch(() => "no launch log")}`,
                  )
                await Bun.sleep(10)
              }
            })
            const child = yield* Effect.promise(() => Bun.file(ready).json() as Promise<{ port: number }>)
            yield* sessions.interrupt(session.id)
            const response = yield* Effect.promise(() => fetch(`http://127.0.0.1:${child.port}`))
            expect(yield* Effect.promise(() => response.text())).toBe("delivered")
            yield* sessions.update({ sessionID: session.id, archived: true })
            expect((yield* jobs.get(job!))?.status).toBe("cancelled")
            expect(
              yield* Effect.promise(() =>
                fetch(`http://127.0.0.1:${child.port}`).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false)
          }).pipe(
            Effect.ensuring(
              settleTool(registry, {
                sessionID: session.id,
                ...toolIdentity,
                call: {
                  type: "tool-call",
                  id: "stop-delivered",
                  name: "bash_job",
                  input: { action: "cancel", job_id: job },
                },
              }).pipe(Effect.orDie),
            ),
          )
        }),
      ),
  )
}
it.effect("378 prompt admission consumes decoded DateTime and clears Stop for new background completion", () =>
  Effect.gen(function* () {
    const logs: unknown[] = []
    yield* withRuntime((directory, sessions) =>
      Effect.gen(function* () {
        const bash = yield* BashJob.Service
        const events = yield* EventV2.Service
        const database = yield* Database.Service
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
        yield* events.publish(SessionExecution.Stopped, { sessionID: session.id })
        const admitted = yield* sessions.prompt({
          sessionID: session.id,
          prompt: { text: "New explicit task" },
          resume: false,
        })
        expect(JSON.stringify(logs)).not.toContain("Event listener failed")
        yield* SessionInput.promoteSteers(database.db, events, session.id, admitted.admittedSeq)
        const id = yield* bash.start(
          "finished fixture",
          Effect.succeed("done"),
          { sessionID: session.id, ...toolIdentity, toolCallID: "decoded-admission" },
          Effect.void,
        )
        yield* Effect.yieldNow
        yield* bash.watch(id)
        expect(yield* SessionInput.find(database.db, SessionMessage.ID.make(`${id}_completed`))).toMatchObject({
          completion: { sourceMessageID: admitted.id, jobID: id },
        })
      }),
    ).pipe(Effect.provide(Logger.layer([Logger.make((entry) => logs.push(entry.message))])))
    expect(JSON.stringify(logs)).not.toContain("Event listener failed")
  }),
)

it.effect("S1 completion keeps durable task identity and never notifies a replacement task", () =>
  withRuntime((directory, sessions) =>
    Effect.gen(function* () {
      const bash = yield* BashJob.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      const original = yield* sessions.prompt({
        sessionID: session.id,
        prompt: { text: "First；Second；Third。" },
        resume: false,
      })
      yield* SessionInput.promoteSteers(database.db, events, session.id, original.admittedSeq)
      const gate = yield* Deferred.make<void>()
      const id = yield* bash.start(
        "once",
        Deferred.await(gate).pipe(Effect.as("done")),
        { sessionID: session.id, ...toolIdentity, toolCallID: "typed" },
        Effect.void,
      )
      yield* bash.watch(id)
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.yieldNow
      yield* bash.watch(id)
      const input = yield* SessionInput.find(database.db, SessionMessage.ID.make(`${id}_completed`))
      expect(input?.completion).toEqual({ type: "bash-completion", sourceMessageID: original.id, jobID: id })
      yield* SessionInput.promoteNextQueued(database.db, events, session.id)
      expect(SessionOutcome.requested(yield* sessions.context(session.id)).sourceMessageID).toBe(original.id)
      const late = yield* Deferred.make<void>()
      const old = yield* bash.start(
        "old task",
        Deferred.await(late).pipe(Effect.as("done")),
        { sessionID: session.id, ...toolIdentity, toolCallID: "late" },
        Effect.void,
      )
      yield* bash.watch(old)
      const next = yield* sessions.prompt({
        sessionID: session.id,
        prompt: { text: "Replacement task" },
        resume: false,
      })
      yield* SessionInput.promoteSteers(database.db, events, session.id, next.admittedSeq)
      yield* Deferred.succeed(late, undefined)
      yield* Effect.yieldNow
      yield* bash.watch(old)
      expect(yield* SessionInput.find(database.db, SessionMessage.ID.make(`${old}_completed`))).toBeUndefined()
    }),
  ),
)
it.effect("S1 completion races notify once, previews stay quiet, and Stop suppresses wake", () =>
  withRuntime((directory, sessions) =>
    Effect.gen(function* () {
      const bash = yield* BashJob.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const wakes: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionExecution.Wake.type)
            wakes.push(Schema.decodeUnknownSync(SessionExecution.Wake.data)(event.data).sessionID)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      for (const scenario of ["task", "preview", "stopped"] as const) {
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
        const gate = yield* Deferred.make<void>()
        const id = yield* bash.start(
          "virtual " + scenario,
          Deferred.await(gate).pipe(Effect.as("done")),
          { sessionID: session.id, ...toolIdentity, toolCallID: scenario },
          Effect.void,
          { kind: scenario === "preview" ? "preview" : "task", workdir: directory },
        )
        yield* bash.watch(id)
        if (scenario === "stopped") yield* sessions.interrupt(session.id)
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.yieldNow
        yield* Effect.all([bash.watch(id), bash.watch(id)], { concurrency: "unbounded" })
        expect(
          (yield* SessionInput.pending(database.db, session.id)).filter((input) => input.id === `${id}_completed`),
        ).toHaveLength(scenario === "task" ? 1 : 0)
        expect(wakes.filter((sessionID) => sessionID === session.id)).toHaveLength(scenario === "task" ? 1 : 0)
      }
    }),
  ),
)

it.effect("469 an unobserved completion still wakes after a visible final answer", () =>
  withRuntime((directory, sessions, registry, jobs) =>
    Effect.gen(function* () {
      const bash = yield* BashJob.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      const input = yield* sessions.prompt({ sessionID: session.id, prompt: { text: "Deliver once" }, resume: false })
      yield* SessionInput.promoteSteers(database.db, events, session.id, input.admittedSeq)
      const gate = yield* Deferred.make<void>()
      const id = yield* bash.start(
        "late completion",
        Deferred.await(gate).pipe(Effect.as("recorded")),
        { sessionID: session.id, ...toolIdentity, toolCallID: "late" },
        Effect.void,
      )
      yield* bash.watch(id)
      const messageID = SessionMessage.ID.create()
      const timestamp = yield* DateTime.now
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: session.id,
        assistantMessageID: messageID,
        timestamp,
        agent: AgentV2.defaultID,
        model: { id: ModelV2.ID.make("fixed"), providerID: ProviderV2.ID.make("fixed") },
      })
      yield* events.publish(SessionEvent.Text.Started, {
        sessionID: session.id,
        assistantMessageID: messageID,
        timestamp,
        textID: "final",
      })
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: session.id,
        assistantMessageID: messageID,
        timestamp,
        textID: "final",
        text: "Delivered; the optional background check is recorded separately.",
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: session.id,
        assistantMessageID: messageID,
        timestamp,
        finish: "stop",
        cost: 0,
        requestPerformed: false,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const wakes: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionExecution.Wake.type) wakes.push(session.id)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* Deferred.succeed(gate, undefined)
      yield* jobs.wait({ id, timeout: 1000 })
      yield* bash.watch(id)
      expect((yield* jobs.get(id))?.status).toBe("completed")
      expect((yield* sessions.message({ sessionID: session.id, messageID: SessionMessage.ID.make(id) }))?.type).toBe(
        "shell",
      )
      expect(yield* SessionInput.find(database.db, SessionMessage.ID.make(`${id}_completed`))).toBeDefined()
      expect(wakes).toEqual([session.id])
    }),
  ),
)

for (const timing of ["late-watch", "queued-before-final"] as const)
  it.effect(`469 delivered result suppresses only its duplicate completion: ${timing}`, () =>
    withRuntime((_directory, sessions, registry, jobs) =>
      Effect.gen(function* () {
        const bash = yield* BashJob.Service
        const events = yield* EventV2.Service
        const database = yield* Database.Service
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make(_directory) } })
        const prompt = yield* sessions.prompt({
          sessionID: session.id,
          prompt: { text: "Read the background result before delivery" },
          resume: false,
        })
        yield* SessionInput.promoteSteers(database.db, events, session.id, prompt.admittedSeq)
        const gate = yield* Deferred.make<void>()
        const id = yield* bash.start(
          "record once",
          Deferred.await(gate).pipe(Effect.as("finished result")),
          { sessionID: session.id, ...toolIdentity, toolCallID: timing },
          Effect.void,
        )
        if (timing === "queued-before-final") yield* bash.watch(id)
        yield* Deferred.succeed(gate, undefined)
        yield* jobs.wait({ id, timeout: 1000 })
        const timestamp = yield* DateTime.now
        const messageID = SessionMessage.ID.create()
        const model = { id: ModelV2.ID.make("fixed"), providerID: ProviderV2.ID.make("fixed") }
        const context = { sessionID: session.id, assistantMessageID: messageID, agent: toolIdentity.agent }
        yield* events.publish(SessionEvent.Step.Started, { ...context, timestamp, model })
        yield* events.publish(SessionEvent.Tool.Input.Started, {
          ...context,
          timestamp,
          callID: "observed",
          name: "bash_job",
        })
        yield* events.publish(SessionEvent.Tool.Called, {
          ...context,
          timestamp,
          callID: "observed",
          tool: "bash_job",
          input: { job_id: id, action: "get" },
          provider: { executed: false },
        })
        const observed = yield* settleTool(registry, {
          ...context,
          call: { type: "tool-call", id: "observed", name: "bash_job", input: { job_id: id, action: "get" } },
        })
        expect(observed.output?.structured).toMatchObject({ status: "completed" })
        yield* events.publish(SessionEvent.Tool.Success, {
          ...context,
          timestamp,
          callID: "observed",
          structured: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
            observed.output?.structured,
          ),
          content: observed.output?.content ?? [],
          provider: { executed: false },
        })
        yield* events.publish(SessionEvent.Step.Ended, {
          ...context,
          timestamp,
          finish: "tool-calls",
          cost: 0,
          requestPerformed: false,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        const final = { ...context, assistantMessageID: SessionMessage.ID.create() }
        yield* events.publish(SessionEvent.Step.Started, { ...final, timestamp, model })
        yield* events.publish(SessionEvent.Text.Started, { ...final, timestamp, textID: "final" })
        yield* events.publish(SessionEvent.Text.Ended, {
          ...final,
          timestamp,
          textID: "final",
          text: "The completed result has been read and delivered.",
        })
        yield* events.publish(SessionEvent.Step.Ended, {
          ...final,
          timestamp,
          finish: "stop",
          cost: 0,
          requestPerformed: false,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        if (timing === "late-watch") {
          yield* bash.watch(id)
          expect(yield* SessionInput.find(database.db, SessionMessage.ID.make(`${id}_completed`))).toBeUndefined()
        } else {
          expect(yield* SessionInput.promoteNextQueued(database.db, events, session.id)).toBe(false)
          expect(
            (yield* SessionInput.find(database.db, SessionMessage.ID.make(`${id}_completed`)))?.cancelledSeq,
          ).toBeDefined()
        }
      }),
    ),
  )

it.effect("S1 completion admission failure retains a safe diagnostic and permits retry", () =>
  Effect.gen(function* () {
    const logs: unknown[] = []
    yield* withRuntime((directory, sessions) =>
      Effect.gen(function* () {
        const bash = yield* BashJob.Service
        const events = yield* EventV2.Service
        const database = yield* Database.Service
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
        const wakes: string[] = []
        const unsubscribe = yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type === SessionExecution.Wake.type)
              wakes.push(Schema.decodeUnknownSync(SessionExecution.Wake.data)(event.data).sessionID)
          }),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        const id = yield* bash.start(
          "finished fixture",
          Effect.succeed("done"),
          { sessionID: session.id, ...toolIdentity, toolCallID: "admission" },
          Effect.void,
        )
        yield* Effect.yieldNow
        yield* database.db.run(
          sql`CREATE TRIGGER reject_notification BEFORE INSERT ON session_input BEGIN SELECT RAISE(ABORT, 'private fixture failure'); END`,
        )
        yield* bash.watch(id)
        expect(yield* SessionInput.find(database.db, SessionMessage.ID.make(`${id}_completed`))).toBeUndefined()
        expect(wakes).toHaveLength(0)
        expect(JSON.stringify(logs)).toContain("Background completion notification admission failed")
        expect(JSON.stringify(logs)).toContain(`${id}_completed`)
        expect(JSON.stringify(logs)).not.toContain("private fixture failure")
        yield* database.db.run(sql`DROP TRIGGER reject_notification`)
        yield* bash.watch(id)
        yield* bash.watch(id)
        expect(
          (yield* SessionInput.pending(database.db, session.id)).filter((input) => input.id === `${id}_completed`),
        ).toHaveLength(1)
        expect(wakes).toEqual([session.id])
      }),
    ).pipe(Effect.provide(Logger.layer([Logger.make((entry) => logs.push(entry.message))])))
  }),
)

it.live(
  "S1 hard deadline kills the same process after soft yield and preserves timeout evidence",
  () =>
    withRuntime((directory, sessions, registry, jobs) =>
      Effect.gen(function* () {
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
        const script = path.join(directory, "hard.cjs")
        const marker = path.join(directory, "late.txt")
        yield* Effect.promise(() =>
          Bun.write(
            script,
            "require('fs').writeFileSync('pid.txt', String(process.pid)); setTimeout(() => require('fs').writeFileSync('late.txt','escaped'), 2500)",
          ),
        )
        const result = yield* settleTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "hard",
            name: "bash",
            input: {
              command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`,
              timeout: 200,
              hard_timeout_ms: 1500,
              verification: "test",
              verification_targets: [script],
              verification_requirements: ["does not finish beyond hard deadline"],
            },
          },
        })
        const id = (result.output?.structured as { job_id: string }).job_id
        expect(id).toBeString()
        const done = yield* jobs.wait({ id, timeout: 5000 })
        expect(done.info).toMatchObject({ id, status: "error" })
        const observed = yield* settleTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: { type: "tool-call", id: "hard-get", name: "bash_job", input: { job_id: id, action: "get" } },
        })
        expect(observed.output?.structured).toMatchObject({
          verification: {
            execution: "timeout",
            exit: -1,
            executionContext: { timeout: { observed: { value: "1500" } } },
          },
        })
        const pid = Number(yield* Effect.promise(() => Bun.file(path.join(directory, "pid.txt")).text()))
        yield* Effect.sleep("1500 millis")
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        expect(() => process.kill(pid, 0)).toThrow()
      }),
    ),
  15000,
)
const withRuntime = <A, E, R>(
  body: (
    directory: string,
    sessions: SessionV2.Interface,
    registry: ToolRegistry.Interface,
    jobs: BackgroundJob.Interface,
  ) => Effect.Effect<A, E, R>,
  silent?: number,
  shell: string = process.platform === "win32" ? "powershell" : "bash",
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const agents = yield* AgentV2.Service
        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("build"), (agent) => {
            agent.permissions = [{ action: "bash", resource: "*", effect: "allow" }]
          }),
        )
        return yield* body(
          tmp.path,
          yield* SessionV2.Service,
          yield* ToolRegistry.Service,
          yield* BackgroundJob.Service,
        )
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              SessionV2.node,
              BashTool.node,
              BashJob.node,
              AgentV2.node,
              ToolRegistry.node,
              BackgroundJob.node,
              Database.node,
              EventV2.node,
            ]),
            [
              [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
              [Global.node, Global.layerWith({ data: tmp.path })],
              [
                Config.node,
                Layer.succeed(Config.Service, {
                  entries: () =>
                    Effect.succeed(
                      silent === undefined && !shell
                        ? []
                        : [
                            new Config.Document({
                              type: "document",
                              info: new Config.Info({
                                shell,
                                experimental: new ConfigExperimental.Experimental({
                                  quality_progress: { silent_command_ms: silent },
                                }),
                              }),
                            }),
                          ],
                    ),
                }),
              ],
              [SessionExecution.node, SessionExecution.noopLayer],
              [
                ProjectV2.node,
                Layer.succeed(ProjectV2.Service, {
                  resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
                  directories: () => Effect.succeed([]),
                  commit: () => Effect.void,
                }),
              ],
            ],
          ),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

for (const prefix of [
  "OMP_NUM_THREADS=1 ",
  "env OMP_NUM_THREADS=1 ",
  "OMP_NUM_THREADS+=1 ",
  "time OMP_NUM_THREADS=1 ",
  "timeout 60 env OMP_NUM_THREADS=1 ",
  "",
  "#literal",
])
  it.live(`N1 actual BashTool contract cannot bless inline overrides: ${prefix}`, () =>
    withRuntime(
      (directory, sessions, registry) =>
        Effect.gen(function* () {
          const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
          const script = path.join(directory, "inline.cjs")
          yield* Effect.promise(() => Bun.write(script, "console.log('actual=' + process.env.OMP_NUM_THREADS)"))
          const command = `${prefix === "#literal" ? "" : prefix}'${process.execPath.replaceAll("\\", "/")}' '${script.replaceAll("\\", "/")}'${prefix === "#literal" ? " 'ordinary-argument' # OMP_NUM_THREADS=1" : ""}`
          const contract = { version: 1 as const, environment: { OMP_NUM_THREADS: "8" } }
          yield* sessions.prompt({
            sessionID: session.id,
            prompt: { text: "Check under approved environment", executionContract: contract },
          })
          const database = yield* Database.Service
          const events = yield* EventV2.Service
          yield* SessionInput.promoteSteers(database.db, events, session.id, Number.MAX_SAFE_INTEGER)
          const result = yield* settleTool(registry, {
            sessionID: session.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "inline-check",
              name: "bash",
              input: { command, verification: "smoke", verification_targets: [script] },
            },
          })
          const overridden = prefix !== "" && prefix !== "#literal"
          expect(JSON.stringify(result.output?.content)).toContain(
            `actual=${prefix.includes("+=") ? "81" : overridden ? "1" : "8"}`,
          )
          const checks = result.output?.structured as {
            verification: Parameters<typeof SessionOutcome.checkFreshness>[0]
          }
          expect(checks.verification.exit).toBe(0)
          expect(checks.verification.executionContext?.environment.OMP_NUM_THREADS?.observed.value).toBe(
            prefix.includes("+=") || prefix.startsWith("time") ? null : overridden ? "1" : "8",
          )
          expect(
            SessionOutcome.checkFreshness(
              checks.verification,
              checks.verification.targets ?? [],
              undefined,
              ExecutionContext.current(checks.verification.executionContext, {
                sourceMessageID: "new-user",
                value: contract,
              }),
            ).fresh,
          ).toBe(!overridden)
          // A persisted certificate must remain invalid when read again for a later request.
          const restored = JSON.parse(JSON.stringify(checks.verification))
          expect(
            SessionOutcome.checkFreshness(
              restored,
              restored.targets,
              undefined,
              ExecutionContext.current(restored.executionContext, { sourceMessageID: "new-user", value: contract }),
            ).fresh,
          ).toBe(!overridden)
          const message: SessionMessage.Assistant = {
            id: SessionMessage.ID.create(),
            type: "assistant",
            agent: "build",
            finish: "stop",
            model: { id: ModelV2.ID.make("offline"), providerID: ProviderV2.ID.make("offline") },
            time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
            content: [
              {
                type: "tool",
                id: "inline-check",
                name: "bash",
                time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
                state: {
                  status: "completed",
                  input: { command },
                  content: [],
                  structured: { verification: checks.verification },
                },
              },
            ],
          }
          yield* database.db
            .insert(SessionMessageTable)
            .values({
              id: message.id,
              session_id: session.id,
              type: "assistant",
              seq: 1_000_000,
              data: Schema.encodeSync(SessionMessage.Message)(message),
            })
            .run()
            .pipe(Effect.orDie)
          const messageID = SessionMessage.ID.create()
          yield* events.publish(SessionEvent.Compaction.Started, {
            sessionID: session.id,
            messageID,
            timestamp: DateTime.makeUnsafe(3),
            reason: "manual",
          })
          yield* events.publish(SessionEvent.Compaction.Ended, {
            sessionID: session.id,
            messageID,
            timestamp: DateTime.makeUnsafe(4),
            reason: "manual",
            text: "All checks passed",
            recent: "",
          })
          const durable = yield* SessionOutcome.history(database.db, session.id)
          const persisted = durable.flatMap((item) =>
            item.type === "assistant"
              ? item.content.flatMap((part) => (part.type === "tool" ? SessionOutcome.toolChecks(part) : []))
              : [],
          )
          expect(persisted).toHaveLength(1)
          expect(
            SessionOutcome.checkFreshness(
              persisted[0],
              checks.verification.targets ?? [],
              undefined,
              ExecutionContext.current(persisted[0].executionContext, ExecutionContext.approved(durable)),
            ).fresh,
          ).toBe(!overridden)
          if (overridden) {
            const outcome = SessionOutcome.derive(
              durable,
              false,
              undefined,
              checks.verification.targets ?? [],
              ["smoke"],
              new Set(),
              directory,
              [],
              true,
              true,
            )
            expect(outcome.state).not.toBe("completed_verified")
            expect(outcome.missing.join(" ")).toContain("OMP_NUM_THREADS: requested condition was not observed")
          }
        }),
      undefined,
      "bash",
    ),
  )

if (process.platform === "win32")
  for (const mode of ["inline", "explicit-conflict", "approved", "inherited"])
    it.live(`N1 real PowerShell and explicit contract control: ${mode}`, () =>
      withRuntime(
        (directory, sessions, registry) =>
          Effect.gen(function* () {
            const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
            const script = path.join(directory, "powershell.cjs")
            yield* Effect.promise(() => Bun.write(script, "console.log('actual=' + process.env.OMP_NUM_THREADS)"))
            const command = `${mode === "inline" ? "$env:OMP_NUM_THREADS='1'; " : ""}& '${process.execPath}' '${script}'`
            const contract = { version: 1 as const, environment: { OMP_NUM_THREADS: mode === "approved" ? "1" : "8" } }
            yield* sessions.prompt({
              sessionID: session.id,
              prompt: { text: "Check approved environment", executionContract: contract },
            })
            const database = yield* Database.Service
            const events = yield* EventV2.Service
            yield* SessionInput.promoteSteers(database.db, events, session.id, Number.MAX_SAFE_INTEGER)
            const result = yield* settleTool(registry, {
              sessionID: session.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: mode,
                name: "bash",
                input: {
                  command,
                  verification: "smoke",
                  verification_targets: [script],
                  ...(mode === "explicit-conflict" || mode === "approved"
                    ? { environment: { OMP_NUM_THREADS: "1" } }
                    : {}),
                },
              },
            })
            expect(JSON.stringify(result.output?.content)).toContain(`actual=${mode === "inherited" ? "8" : "1"}`)
            const output = result.output?.structured as {
              exit: number
              verification?: Parameters<typeof SessionOutcome.checkFreshness>[0]
            }
            expect(output.exit).toBe(0)
            if (mode === "inline") {
              // Compound PowerShell commands are deliberately not certified at all.
              expect(output.verification).toBeUndefined()
              return
            }
            expect(output.verification).toBeDefined()
            expect(
              SessionOutcome.checkFreshness(
                output.verification!,
                output.verification!.targets ?? [],
                undefined,
                ExecutionContext.current(output.verification!.executionContext, {
                  sourceMessageID: "user",
                  value: contract,
                }),
              ).fresh,
            ).toBe(mode !== "explicit-conflict")
          }),
        undefined,
        "powershell",
      ),
    )

it.live("K3 records the actual explicit launch environment without scanning command comments", () =>
  withRuntime((directory, sessions, registry) =>
    Effect.gen(function* () {
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      const script = path.join(directory, "environment.cjs")
      yield* Effect.promise(() => Bun.write(script, "console.log('threads=' + process.env.OMP_NUM_THREADS)"))
      const result = yield* settleTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "launch-environment",
          name: "bash",
          input: {
            command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`,
            environment: { OMP_NUM_THREADS: "2" },
            verification: "smoke",
            verification_targets: [script],
          },
        },
      })
      if (result.result.type === "error") throw new Error(JSON.stringify(result))
      expect(result.output?.structured).toMatchObject({
        verification: {
          exit: 0,
          executionContext: {
            environment: {
              OMP_NUM_THREADS: {
                requested: { value: "2", source: "diagnostic-temporary" },
                observed: { value: "2", source: "observed" },
              },
            },
          },
        },
      })
      expect(JSON.stringify(result.output?.content)).toContain("threads=2")
    }),
  ),
)

it.live("K3 user prompt execution contract reaches launch and survives durable promotion", () =>
  withRuntime((directory, sessions, registry) =>
    Effect.gen(function* () {
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      const script = path.join(directory, "approved.cjs")
      yield* Effect.promise(() => Bun.write(script, "console.log(process.env.OMP_NUM_THREADS)"))
      const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`
      yield* sessions.prompt({
        sessionID: session.id,
        prompt: {
          text: "Run the approved entry",
          executionContract: { version: 1, entry: command, environment: { OMP_NUM_THREADS: "2" }, samples: ["first"] },
        },
      })
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      yield* SessionInput.promoteSteers(database.db, events, session.id, Number.MAX_SAFE_INTEGER)
      const result = yield* settleTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "approved-environment",
          name: "bash",
          input: {
            command,
            environment: { OMP_NUM_THREADS: "2" },
            verification: "smoke",
            verification_targets: [script],
            verification_sample: "first",
          },
        },
      })
      expect(result.output?.structured).toMatchObject({
        verification: {
          executionContext: {
            entry: { requested: { value: command, source: "user" } },
            environment: {
              OMP_NUM_THREADS: {
                requested: { value: "2", source: "user" },
                observed: { value: "2", source: "observed" },
              },
            },
            contract: { version: 1, sourceMessageID: expect.stringContaining("msg_") },
          },
        },
      })
      expect(result.output?.structured).toMatchObject({
        verification: { sample: { id: "first", planDigest: expect.any(String) }, resultDigest: expect.any(String) },
      })
    }),
  ),
)

it.live("records real syntax failures and file-bound verification evidence", () =>
  withRuntime((directory, sessions, registry) =>
    Effect.gen(function* () {
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      const target = path.join(directory, "game.html")
      const script = path.join(directory, "check.cjs")
      yield* Effect.promise(() => Bun.write(target, "<script>const x = ];</script>"))
      yield* Effect.promise(() =>
        Bun.write(
          script,
          `const fs=require('fs'); const vm=require('vm');new vm.Script(fs.readFileSync(${JSON.stringify(target)},'utf8').match(/<script>([\\s\\S]*)<\\/script>/)[1]).runInNewContext();`,
        ),
      )
      const command = `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`
      const run = (id: string) =>
        settleTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id,
            name: "bash",
            input: { command, verification: "syntax", verification_targets: [target] },
          },
        })
      const failed = yield* run("syntax-failed")
      expect(failed.output?.structured).toMatchObject({
        verification: { kind: "syntax", exit: 1, targets: [{ path: target, digest: expect.any(String) }] },
      })
      yield* Effect.promise(() => Bun.write(target, "<script>const x = 1;</script>"))
      const passed = yield* run("syntax-passed")
      expect(passed.output?.structured).toMatchObject({
        verification: { kind: "syntax", exit: 0, targets: [{ path: target, digest: expect.any(String) }] },
      })
      expect(JSON.stringify(passed.output?.content)).toContain("ev_")
      expect(passed.outputPaths?.length).toBeGreaterThan(0)
    }),
  ),
)

it.live("retains bytes beyond the shell preview cap in the registry-owned log", () =>
  withRuntime((directory, sessions, registry) =>
    Effect.gen(function* () {
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      const script = path.join(directory, "verbose.js")
      const content = "HEAD" + "x".repeat(700_000) + "MIDDLE" + "y".repeat(700_000) + "TAIL"
      yield* Effect.promise(() => Bun.write(script, `process.stdout.write(${JSON.stringify(content)})`))
      const result = yield* settleTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "verbose",
          name: "bash",
          input: { command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"` },
        },
      })
      expect(result.result.type).not.toBe("error")
      expect(result.output?.structured).toMatchObject({ truncated: true })
      expect(yield* Effect.promise(() => Bun.file(result.outputPaths![0]).text())).toBe(content)
    }),
  ),
)

it.live("background commands settle durably, enforce ownership, and stop with their Session", () =>
  withRuntime((directory, sessions, registry) =>
    Effect.gen(function* () {
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      const other = yield* sessions.create({ location: session.location })
      const script = path.join(directory, "background.js")
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      const wakes: string[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionExecution.Wake.type)
            wakes.push(Schema.decodeUnknownSync(SessionExecution.Wake.data)(event.data).sessionID)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* Effect.promise(() => Bun.write(script, "process.stdout.write('finished');"))
      const start = (id: string, timeout?: number) =>
        settleTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id,
            name: "bash",
            input: {
              command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`,
              run_in_background: true,
              ...(timeout === undefined ? {} : { timeout }),
            },
          },
        })
      const first = yield* start("background")
      const job = (first.output?.structured as { job_id: string }).job_id
      const observe = (sessionID: SessionV2.ID, action: string) =>
        settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: `observe-${action}`,
            name: "bash_job",
            input: { job_id: job, action, timeout: 120000 },
          },
        })
      expect((yield* observe(other.id, "cancel")).result.type).toBe("error")
      const finished = yield* observe(session.id, "wait")
      expect(finished.output?.structured).toMatchObject({
        status: "completed",
      })
      expect(JSON.stringify(finished.output?.content)).toContain("finished")
      expect(JSON.stringify(finished.output?.content)).not.toContain("clamped to 60000ms")
      expect(yield* Effect.promise(() => Bun.file(first.outputPaths![0]).text())).toBe("finished")
      expect(
        (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.type === "shell"),
      ).toHaveLength(1)
      yield* start("background")
      expect(
        (yield* SessionInput.pending(database.db, session.id)).filter((input) => input.id === `${job}_completed`),
      ).toHaveLength(1)
      expect(wakes).toEqual([session.id])
      expect(
        (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.type === "shell"),
      ).toHaveLength(1)
      yield* Effect.promise(() => Bun.write(script, "process.stdout.write('running'); setInterval(() => {}, 1000)"))
      const second = yield* start("long", 0)
      // Ordinary background work remains part of task execution.
      expect((yield* sessions.outcome(session.id)).state).toBe("running")
      yield* sessions.interrupt(session.id)
      const stopped = yield* settleTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "stopped",
          name: "bash_job",
          input: { job_id: (second.output?.structured as { job_id: string }).job_id, action: "get" },
        },
      })
      expect(stopped.output?.structured).toMatchObject({ status: "cancelled" })
      const shells = (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.type === "shell")
      expect(shells.every((message) => message.time.completed !== undefined)).toBe(true)
      const bounded = yield* start("bounded", 300)
      const timed = yield* settleTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "timed",
          name: "bash_job",
          input: { job_id: (bounded.output?.structured as { job_id: string }).job_id, action: "wait", timeout: 500 },
        },
      })
      expect(timed.output?.structured).toMatchObject({ status: "running" })
      yield* sessions.interrupt(session.id)
    }),
  ),
)

it.live("Stop preserves explicit previews; archive closes only owned services", () =>
  withRuntime((directory, sessions, registry, jobs) =>
    Effect.gen(function* () {
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      const other = yield* sessions.create({ location: session.location })
      const script = path.join(directory, "preview.js")
      yield* Effect.promise(() => Bun.write(script, "setInterval(() => {}, 1000)"))
      const start = (sessionID: SessionV2.ID) =>
        settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: sessionID,
            name: "bash",
            input: {
              command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`,
              run_in_background: true,
              background_kind: "preview",
              workdir: directory,
            },
          },
        })
      const first = yield* start(session.id)
      const second = yield* start(other.id)
      const observe = (sessionID: SessionV2.ID, job: typeof first, action = "get") =>
        settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: `observe-${action}`,
            name: "bash_job",
            input: {
              job_id: (job.output?.structured as { job_id: string }).job_id,
              action,
            },
          },
        })
      expect((yield* sessions.outcome(session.id)).state).toBe("idle")
      yield* sessions.interrupt(session.id)
      expect((yield* observe(session.id, first)).output?.structured).toMatchObject({
        status: "running",
        kind: "preview",
        workdir: directory,
      })
      yield* sessions.update({ sessionID: session.id, archived: true })
      expect((yield* observe(session.id, first)).output?.structured).toMatchObject({ status: "cancelled" })
      expect((yield* observe(other.id, second)).output?.structured).toMatchObject({ status: "running" })
      yield* sessions.remove(other.id)
      expect((yield* jobs.get((second.output?.structured as { job_id: string }).job_id))?.status).toBe("cancelled")
    }),
  ),
)

it.live("Q2 silence yields a live owned process and never certifies pending checks", () =>
  withRuntime(
    (directory, sessions, registry, jobs) =>
      Effect.gen(function* () {
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
        const script = path.join(directory, "silent.cjs")
        const marker = path.join(directory, "finished.txt")
        yield* Effect.promise(() =>
          Bun.write(
            script,
            "setTimeout(() => { require('fs').writeFileSync('finished.txt', 'once'); console.log('done') }, 1800)",
          ),
        )
        const result = yield* settleTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "silent",
            name: "bash",
            input: {
              command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`,
              verification: "test",
              verification_targets: [script],
              verification_requirements: ["writes marker"],
            },
          },
        })
        const data = result.output?.structured as { job_id?: string; verification?: unknown }
        expect(data.job_id).toBeString()
        expect(data.verification).toBeUndefined()
        expect((yield* jobs.get(data.job_id!))?.status).toBe("running")
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        expect((yield* sessions.outcome(session.id)).state).not.toBe("completed_verified")
        const done = yield* settleTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "wait-silent",
            name: "bash_job",
            input: { job_id: data.job_id, action: "wait" },
          },
        })
        expect(done.output?.structured).toMatchObject({ status: "completed", verification: { exit: 0 } })
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("once")
        const check = SessionOutcome.toolChecks(
          SessionMessage.AssistantTool.make({
            type: "tool",
            id: "wait-silent",
            name: "bash_job",
            time: { created: DateTime.nowUnsafe() },
            state: SessionMessage.ToolStateCompleted.make({
              status: "completed",
              input: { job_id: data.job_id, action: "wait" },
              structured: done.output!.structured as Record<string, unknown>,
              content: [],
            }),
          }),
        )
        expect(check).toHaveLength(1)
        expect(check[0]!.callID).toBe("silent")
        expect(check[0]!.executionRecord?.originCallID).toBe("silent")
        const persisted = yield* sessions.message({
          sessionID: session.id,
          messageID: SessionMessage.ID.make(data.job_id!),
        })
        expect(persisted?.type === "shell" && persisted.executionRecord?.id).toBe(check[0]!.executionRecord?.id)
        const database = yield* Database.Service
        const durable = yield* SessionOutcome.history(database.db, session.id)
        expect(SessionOutcome.historyCandidates(SessionOutcome.executions(durable))).toContainEqual({
          callID: "silent",
          exit: 0,
        })
        // Restore a durable completion without a process-local job/result cache.
        const events = yield* EventV2.Service
        const restoredID = SessionMessage.ID.make("msg_bash_restored_silent")
        const execution = check[0]!.executionRecord!
        yield* events.publish(SessionEvent.Shell.Started, {
          sessionID: session.id,
          messageID: restoredID,
          callID: restoredID,
          command: check[0]!.command,
          timestamp: DateTime.makeUnsafe(execution.started),
        })
        yield* events.publish(SessionEvent.Shell.Ended, {
          sessionID: session.id,
          callID: restoredID,
          output: "done",
          executionRecord: { ...execution, jobID: restoredID },
          checks: [{ ...check[0]!, executionRecord: { ...execution, jobID: restoredID } }],
          timestamp: DateTime.makeUnsafe(execution.completed!),
        })
        const restored = yield* settleTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "read-restored",
            name: "bash_job",
            input: { job_id: restoredID, action: "get" },
          },
        })
        expect(restored.output?.structured).toMatchObject({
          status: "finished",
          executionRecord: { id: execution.id },
          verifications: [{ callID: "silent", executionRecord: { id: execution.id } }],
        })
      }),
    150,
  ),
)

it.live(
  "S1 fresh output resets silence and timeout hands ownership to background",
  () =>
    withRuntime(
      (directory, sessions, registry, jobs) =>
        Effect.gen(function* () {
          const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
          const script = path.join(directory, "output.cjs")
          yield* Effect.promise(() =>
            Bun.write(
              script,
              "let n=0; console.log('start'); const timer=setInterval(() => { console.log(++n); if(n===70) clearInterval(timer) }, 60)",
            ),
          )
          const execute = (id: string, timeout?: number) =>
            settleTool(registry, {
              sessionID: session.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id,
                name: "bash",
                input: {
                  command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`,
                  ...(timeout === undefined ? {} : { timeout }),
                },
              },
            })
          const result = yield* execute("output-reset")
          expect(result.output?.structured).toMatchObject({ exit: 0 })
          expect((result.output?.structured as { job_id?: string }).job_id).toBeUndefined()
          yield* Effect.promise(() => Bun.write(script, "setTimeout(() => {}, 4000)"))
          const timed = yield* execute("explicit-timeout", 2500)
          const timedJob = (timed.output?.structured as { job_id?: string }).job_id
          expect(timedJob).toBeString()
          expect((yield* jobs.wait({ id: timedJob!, timeout: 5000 })).info?.status).toBe("completed")
        }),
      3000,
    ),
  20000,
)

it.live(
  "Q2 exact managed retry returns the original handle without waiting on a new process",
  () =>
    withRuntime(
      (directory, sessions, registry, jobs) =>
        Effect.gen(function* () {
          const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
          const script = path.join(directory, "retry.cjs")
          yield* Effect.promise(() =>
            Bun.write(script, "require('fs').appendFileSync('runs.txt', 'x'); setTimeout(() => {}, 1800)"),
          )
          const invoke = () =>
            settleTool(registry, {
              sessionID: session.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "same-managed",
                name: "bash",
                input: { command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"` },
              },
            })
          const first = yield* invoke()
          const second = yield* invoke().pipe(Effect.timeout("500 millis"))
          expect(second.output?.structured).toMatchObject({
            job_id: (first.output?.structured as { job_id: string }).job_id,
          })
          const id = (first.output?.structured as { job_id: string }).job_id
          yield* jobs.wait({ id, timeout: 5000 })
          expect(yield* Effect.promise(() => Bun.file(path.join(directory, "runs.txt")).text())).toBe("x")
        }),
      100,
    ),
  10000,
)

it.live("Q4 default bash schema exposes optional observation fields without enabling silence", () =>
  withRuntime((_directory, _sessions, registry) =>
    Effect.gen(function* () {
      const snapshot = yield* registry.materialize()
      const bash = snapshot.definitions.find((tool) => tool.name === "bash")
      expect(JSON.stringify(bash?.inputSchema)).toContain("progress_hypothesis")
      expect(JSON.stringify(bash?.inputSchema)).toContain("progress_expected_evidence")
    }),
  ),
)

it.live("367 S1 foreground timeout retains the same process identity without retry", () =>
  withRuntime((directory, sessions, registry) =>
    Effect.gen(function* () {
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      const script = path.join(directory, "survive.cjs")
      const marker = path.join(directory, "launches.txt")
      yield* Effect.promise(() =>
        Bun.write(
          script,
          `require('fs').appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n'); setTimeout(() => console.log('survived ' + process.pid), 1500)`,
        ),
      )
      const first = yield* settleTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "survive",
          name: "bash",
          input: {
            command: `${process.platform === "win32" ? "& " : ""}"${process.execPath}" "${script}"`,
            timeout: 300,
          },
        },
      })
      const job = (first.output?.structured as { job_id?: string })?.job_id
      expect(job).toBeDefined()
      yield* Effect.promise(async () => {
        const deadline = Date.now() + 5000
        while (!(await Bun.file(marker).exists())) {
          if (Date.now() >= deadline) throw new Error("Background child did not start")
          await Bun.sleep(20)
        }
      })
      const originalPID = yield* Effect.promise(() => Bun.file(marker).text())
      const done = yield* settleTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "wait-survive",
          name: "bash_job",
          input: { job_id: job, action: "wait", timeout: 120000 },
        },
      })
      expect(done.output?.structured).toMatchObject({ status: "completed" })
      expect(JSON.stringify(done.output?.content)).toContain("survived")
      expect(JSON.stringify(done.output?.content)).toContain(originalPID.trim())
      expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe(originalPID)
      expect(originalPID.trim().split("\n")).toHaveLength(1)
      expect(JSON.stringify(done.output?.content)).not.toContain("clamped")
      const database = yield* Database.Service
      const notification = yield* SessionInput.find(database.db, SessionMessage.ID.make(`${job}_completed`))
      expect(notification?.delivery).toBe("queue")
      expect(notification?.prompt.text).toContain(job!)
    }),
  ),
)

it.effect("S1 twenty minute job supports twelve waits and one durable completion", () =>
  withRuntime((directory, sessions, registry, jobs) =>
    Effect.gen(function* () {
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      const bash = yield* BashJob.Service
      const id = yield* bash.start(
        "simulated long command",
        Effect.sleep("20 minutes").pipe(Effect.as("done")),
        { sessionID: session.id, ...toolIdentity, toolCallID: "twenty-minutes" },
        Effect.void,
      )
      yield* bash.watch(id)
      for (let index = 0; index < 12; index++) {
        const wait = yield* settleTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: `wait-${index}`,
            name: "bash_job",
            input: { job_id: id, action: "wait", timeout: 90000 },
          },
        }).pipe(Effect.forkChild)
        yield* adjust(90000)
        expect((yield* Fiber.join(wait)).output?.structured).toMatchObject({ status: "running" })
      }
      yield* adjust("2 minutes")
      expect((yield* jobs.get(id))?.status).toBe("completed")
      const database = yield* Database.Service
      const notification = yield* SessionInput.find(database.db, SessionMessage.ID.make(`${id}_completed`))
      expect(notification?.delivery).toBe("queue")
      yield* bash.watch(id)
      expect(
        (yield* SessionInput.pending(database.db, session.id)).filter((input) => input.id === `${id}_completed`),
      ).toHaveLength(1)
    }),
  ),
)
