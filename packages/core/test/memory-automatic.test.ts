import { expect, test } from "bun:test"
import path from "node:path"
import { DateTime, Deferred, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { BackgroundJob } from "../src/background-job"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { MemoryAutomatic } from "../src/memory/automatic"
import { MemoryTidyStore } from "../src/memory/tidy-store"
import { MemoryTidyTasks } from "../src/memory/tidy-tasks"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionExecutionLocal } from "../src/session/execution/local"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { SessionRunner } from "../src/session/runner/index"
import { node } from "../src/session/runner/llm"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

const model = { id: ModelV2.ID.make("offline"), providerID: ProviderV2.ID.make("offline") }

for (const scenario of ["complete", "yield", "disable", "brief-background", "missing-config", "empty-config"] as const)
  test(`automatic host uses the real coordinator and durable task lifecycle: ${scenario}`, async () => {
    await using tmp = await tmpdir()
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const state = {
      memory: { enabled: true } as { enabled?: boolean } | undefined,
      calls: 0,
      run: (_id: SessionV2.ID): Effect.Effect<void> => Effect.die("Runner not initialized"),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const automatic = yield* MemoryAutomatic.Service
        const sessions = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const database = yield* Database.Service
        const store = yield* MemoryTidyStore.Service
        const tasks = yield* MemoryTidyTasks.Service
        const execution = yield* SessionExecution.Service
        const jobs = yield* BackgroundJob.Service
        const directory = AbsolutePath.make(tmp.path)
        const finish = (sessionID: SessionV2.ID) =>
          Effect.gen(function* () {
            const timestamp = yield* DateTime.now
            const assistantMessageID = SessionMessage.ID.create()
            yield* events.publish(SessionEvent.Step.Started, {
              sessionID,
              timestamp,
              assistantMessageID,
              model,
              agent: "build",
            })
            yield* events.publish(SessionEvent.Step.Ended, {
              sessionID,
              timestamp,
              assistantMessageID,
              finish: "stop",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            })
          })
        state.run = (sessionID) =>
          Effect.gen(function* () {
            state.calls++
            yield* SessionInput.promoteSteers(database.db, events, sessionID, Number.MAX_SAFE_INTEGER)
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            yield* finish(sessionID)
          }).pipe(Effect.orDie)
        const source = yield* sessions.create({ model, location: { directory } })
        yield* events.publish(SessionEvent.Prompted, {
          sessionID: source.id,
          timestamp: yield* DateTime.now,
          messageID: SessionMessage.ID.create(),
          prompt: { text: "Ordinary work" },
          delivery: "steer",
        })
        yield* finish(source.id)
        expect(yield* automatic.get(directory)).toBeUndefined()
        yield* automatic.tick
        expect(state.calls).toBe(0)
        yield* automatic.confirm(directory, { requestID: "consent", model, tokens: 200, dailyTokens: 1000 })
        if (scenario === "missing-config" || scenario === "empty-config") {
          state.memory = scenario === "missing-config" ? undefined : {}
          yield* automatic.tick
          yield* TestClock.adjust("2 minutes")
          yield* automatic.tick
          expect(state.calls).toBe(0)
          expect((yield* automatic.get(directory))?.current_run).toBeNull()
          return
        }
        yield* automatic.tick
        if (scenario === "brief-background") {
          yield* TestClock.adjust("30 seconds")
          const job = yield* jobs.start({ type: "brief", run: Effect.succeed("done") })
          yield* jobs.wait({ id: job.id })
          yield* TestClock.adjust("30 seconds")
          yield* automatic.tick
          expect(state.calls).toBe(0)
          expect((yield* automatic.get(directory))?.current_run).toBeNull()
        }
        yield* TestClock.adjust("59999 millis")
        yield* automatic.tick
        expect(state.calls).toBe(0)
        yield* TestClock.adjust("1 millis")
        yield* automatic.tick
        yield* Deferred.await(entered)
        expect(state.calls).toBe(1)
        const id = (yield* automatic.get(directory))!.current_run!
        const run = (yield* store.get(id))!
        expect((yield* execution.active).has(run.session_id)).toBe(true)
        if (scenario === "complete" || scenario === "brief-background") {
          yield* Deferred.succeed(release, undefined)
          yield* execution.wait!(run.session_id)
          while ((yield* tasks.active).has(id)) yield* Effect.yieldNow
          expect((yield* store.get(id))?.state).toBe("completed")
        }
        if (scenario === "yield") {
          const job = yield* jobs.start({ type: "ordinary", run: Effect.never })
          yield* automatic.tick
          expect((yield* store.get(id))?.state).toBe("cancelled")
          expect((yield* execution.active).has(run.session_id)).toBe(false)
          yield* jobs.cancel(job.id)
        }
        if (scenario === "disable") {
          yield* automatic.disable(directory, "consent")
          expect((yield* automatic.get(directory))?.enabled).toBe(false)
          expect((yield* store.get(id))?.state).toBe("cancelled")
          expect((yield* execution.active).has(run.session_id)).toBe(false)
        }
        yield* automatic.tick
        yield* TestClock.adjust("2 minutes")
        yield* automatic.tick
        expect(state.calls).toBe(1)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              MemoryAutomatic.node,
              MemoryTidyStore.node,
              MemoryTidyTasks.node,
              SessionV2.node,
              EventV2.node,
              Database.node,
              SessionExecution.node,
              BackgroundJob.node,
            ]),
            [
              [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
              [
                Global.node,
                Global.layerWith({
                  data: path.join(tmp.path, "data"),
                  config: path.join(tmp.path, "config"),
                  state: path.join(tmp.path, "state"),
                }),
              ],
              [SessionExecution.node, SessionExecutionLocal.node],
              [
                node,
                Layer.succeed(
                  SessionRunner.Service,
                  SessionRunner.Service.of({
                    run: (input) => state.run(input.sessionID),
                    compact: () => Effect.succeed(false),
                  }),
                ),
              ],
              [
                Config.node,
                Layer.succeed(
                  Config.Service,
                  Config.Service.of({
                    entries: () =>
                      Effect.succeed([
                        new Config.Document({ type: "document", info: new Config.Info({ memory: state.memory }) }),
                      ]),
                  }),
                ),
              ],
            ],
          ),
        ),
        Effect.provide(TestClock.layer()),
        Effect.scoped,
      ),
    )
  }, 30000)
