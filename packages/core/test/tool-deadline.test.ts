import { expect } from "bun:test"
import { Clock, Deferred, Effect, Fiber, Layer } from "effect"
import { adjust } from "effect/testing/TestClock"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { SessionV2 } from "../src/session"
import { SessionInput } from "../src/session/input"
import { SessionExecution } from "../src/session/execution"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Config } from "../src/config"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { PermissionV2 } from "../src/permission"
import { AppProcess } from "../src/process"
import { BackgroundJob } from "../src/background-job"
import { BashTool } from "../src/tool/bash"
import { BashJob } from "../src/tool/bash-job"
import { ToolRegistry } from "../src/tool/registry"
import { tmpdir } from "./fixture/tmpdir"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)

function runtime<A, E, R>(
  body: (directory: string, started: Deferred.Deferred<void>, dispatched: string[]) => Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.promise(tmpdir),
    (tmp) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const dispatched: string[] = []
        return yield* body(tmp.path, started, dispatched).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                SessionV2.node,
                Database.node,
                EventV2.node,
                BashTool.node,
                BashJob.node,
                ToolRegistry.toolsNode,
                BackgroundJob.node,
              ]),
              [
                [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
                [Global.node, Global.layerWith({ data: tmp.path })],
                [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
                [SessionExecution.node, SessionExecution.noopLayer],
                [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
                [
                  AppProcess.node,
                  Layer.mock(AppProcess.Service, {
                    run: (command) =>
                      Effect.gen(function* () {
                        dispatched.push(command._tag)
                        yield* Deferred.succeed(started, undefined)
                        return yield* Effect.never
                      }),
                  }),
                ],
              ],
            ),
          ),
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}

for (const remaining of [0, -1])
  it.effect(`490 leaf absolute deadline ${remaining} denies OS dispatch`, () =>
    runtime((directory, _started, dispatched) =>
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const registry = yield* ToolRegistry.Service
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
        yield* sessions.prompt({
          sessionID: session.id,
          prompt: {
            text: "Run the check",
            runPolicy: { mode: "unattended", deadline: (yield* Clock.currentTimeMillis) + remaining },
          },
          resume: false,
        })
        yield* SessionInput.promoteSteers(database.db, events, session.id, Number.MAX_SAFE_INTEGER)
        const result = yield* settleTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: { type: "tool-call", id: "expired", name: "bash", input: { command: "echo deadline" } },
        })
        expect(result.result.type).toBe("error")
        expect(dispatched).toHaveLength(0)
      }),
    ),
  )

it.effect("490 foreground observation is bounded by shared D without terminating or restarting the live process", () =>
  runtime((directory, started, dispatched) =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const registry = yield* ToolRegistry.Service
      const jobs = yield* BackgroundJob.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      yield* sessions.prompt({
        sessionID: session.id,
        prompt: {
          text: "Run a bounded check",
          runPolicy: { mode: "unattended", deadline: (yield* Clock.currentTimeMillis) + 500 },
        },
        resume: false,
      })
      yield* SessionInput.promoteSteers(database.db, events, session.id, Number.MAX_SAFE_INTEGER)
      const waiting = yield* settleTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: { type: "tool-call", id: "clamped", name: "bash", input: { command: "echo deadline", timeout: 600_000 } },
      }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* adjust(501)
      const result = yield* Fiber.join(waiting)
      expect(result.result.type).toBe("content")
      expect(result.output?.structured).toMatchObject({ job_id: "msg_bash_msg_tool_test_clamped", kind: "task" })
      expect(dispatched).toHaveLength(1)
      const task = (yield* jobs.list()).find((job) => job.metadata?.sessionID === session.id)
      expect(task?.status).toBe("running")
      if (!task) throw new Error("The same process must have been handed to a retained job")
      yield* jobs.cancel(task.id)
    }),
  ),
)

it.effect("490 bash_job wait uses shared D while get/cancel remain available and preview is preserved", () =>
  runtime((directory, _started, dispatched) =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const registry = yield* ToolRegistry.Service
      const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
      yield* sessions.prompt({
        sessionID: session.id,
        prompt: {
          text: "Observe an owned service",
          runPolicy: { mode: "unattended", deadline: (yield* Clock.currentTimeMillis) + 500 },
        },
        resume: false,
      })
      yield* SessionInput.promoteSteers(database.db, events, session.id, Number.MAX_SAFE_INTEGER)
      const bash = yield* BashJob.Service
      const jobs = yield* BackgroundJob.Service
      const id = yield* bash.start(
        "retained-preview",
        Effect.never,
        { sessionID: session.id, ...toolIdentity, toolCallID: "preview" },
        Effect.void,
        { kind: "preview", workdir: directory },
      )
      yield* Effect.addFinalizer(() => jobs.cancel(id))
      const call = (action: "wait" | "get" | "cancel") =>
        settleTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: {
            type: "tool-call" as const,
            id: action,
            name: "bash_job",
            input: { job_id: id, action, timeout: 600_000 },
          },
        })
      const waiting = yield* call("wait").pipe(Effect.forkChild)
      for (let i = 0; i < 40; i++) yield* Effect.yieldNow
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* adjust(501)
      expect((yield* Fiber.join(waiting)).output?.structured).toMatchObject({ status: "running", kind: "preview" })
      expect((yield* jobs.get(id))?.status).toBe("running")
      expect((yield* call("wait")).result.type).toBe("error")
      expect((yield* call("get")).output?.structured).toMatchObject({ status: "running" })
      expect((yield* call("cancel")).output?.structured).toMatchObject({ status: "cancelled" })
      expect((yield* jobs.get(id))?.status).toBe("cancelled")
      expect(dispatched).toHaveLength(0)
    }),
  ),
)
