import { expect, test } from "bun:test"
import path from "node:path"
import { Cause, Context, Deferred, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { MemoryTidy } from "../src/memory/tidy"
import { MemoryTidyStore } from "../src/memory/tidy-store"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionRunCoordinator } from "../src/session/run-coordinator"
import { SessionTable } from "../src/session/sql"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

const model = { id: ModelV2.ID.make("tidy-model"), providerID: ProviderV2.ID.make("tidy-provider") }
const request = { requestID: "confirmed-click", model }
const setup = Effect.gen(function* () {
  return {
    tidy: yield* MemoryTidy.Service,
    store: yield* MemoryTidyStore.Service,
    sessions: yield* SessionV2.Service,
    database: yield* Database.Service,
    execution: yield* SessionExecution.Service,
  }
})
type State = {
  started: Deferred.Deferred<void>[]
  finished: number[]
  count: number
  cleanup: Effect.Effect<void>
  rival: Database.Interface
}
async function withHost(body: (h: Effect.Success<typeof setup>, state: State) => Effect.Effect<void, unknown>) {
  await using tmp = await tmpdir()
  await Effect.runPromise(
    Effect.gen(function* () {
      const connection = yield* Layer.build(Database.layerFromPath(path.join(tmp.path, "host.sqlite")))
      const rival = Context.get(connection, Database.Service)
      const state: State = {
        started: [Deferred.makeUnsafe(), Deferred.makeUnsafe()],
        finished: [],
        count: 0,
        cleanup: Effect.void,
        rival,
      }
      const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, never>({
        drain: () =>
          Effect.suspend(() => {
            const index = state.count++
            return Deferred.succeed(state.started[index]!, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.suspend(() => state.cleanup).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      state.finished.push(index)
                    }),
                  ),
                ),
              ),
            )
          }),
      })
      yield* setup.pipe(
        Effect.flatMap((h) => body(h, state)),
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              MemoryTidy.node,
              MemoryTidyStore.node,
              SessionV2.node,
              Database.node,
              Config.node,
              SessionExecution.node,
            ]),
            [
              [Database.node, Database.layerFromPath(path.join(tmp.path, "host.sqlite"))],
              [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
              [
                Global.node,
                Global.layerWith({
                  data: path.join(tmp.path, "data"),
                  config: path.join(tmp.path, "config"),
                  state: path.join(tmp.path, "state"),
                }),
              ],
              [
                Config.node,
                Layer.succeed(Config.Service, {
                  entries: () =>
                    Effect.succeed([
                      new Config.Document({ type: "document", info: new Config.Info({ memory: { enabled: true } }) }),
                    ]),
                }),
              ],
              [
                SessionExecution.node,
                Layer.succeed(SessionExecution.Service, {
                  active: coordinator.active,
                  resume: coordinator.run,
                  wake: coordinator.wake,
                  interrupt: coordinator.interrupt,
                  prepareInterrupt: coordinator.prepareInterrupt,
                  freezeWake: coordinator.freezeWake,
                }),
              ],
            ],
          ),
        ),
      )
    }).pipe(Effect.scoped),
  )
}

test("bound cancellation rejects an incarnation replaced after the tidy run snapshot", () =>
  withHost((h, state) =>
    Effect.gen(function* () {
      const run = (yield* h.tidy.prepare(request)).run
      const session = yield* h.sessions.get(run.session_id)
      yield* h.execution.resume(run.session_id).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(state.started[0]!)
      const cancel = h.sessions.cancelPending
      let injected = false
      Object.defineProperty(h.sessions, "cancelPending", {
        value: (input: Parameters<typeof cancel>[0]) =>
          Effect.gen(function* () {
            injected = true
            yield* h.sessions.remove(run.session_id)
            yield* h.sessions.create({ id: run.session_id, model, location: session.location })
            const fresh = yield* h.sessions.prompt({
              id: run.input!.id,
              sessionID: run.session_id,
              resume: false,
              prompt: { text: "replacement" },
            })
            expect(fresh.admittedSeq).not.toBe(run.input!.seq)
            yield* h.execution.resume(run.session_id).pipe(Effect.exit, Effect.forkChild)
            yield* Deferred.await(state.started[1]!)
            yield* cancel(input)
          }),
      })
      yield* h.tidy.cancel(run.id)
      expect(injected).toBe(true)
      expect(yield* h.sessions.pendingInputs(run.session_id)).toHaveLength(1)
      expect((yield* h.execution.active).has(run.session_id)).toBe(true)
      expect(state.finished).toEqual([0])
      yield* h.execution.interrupt(run.session_id)
    }),
  ))

test("failed projection releases its frozen execution outside the transaction and can retry", () =>
  withHost((h, state) =>
    Effect.gen(function* () {
      const run = (yield* h.tidy.prepare(request)).run
      yield* h.store.reserve({
        sessionID: run.session_id,
        scope: run.scope,
        enabled: true,
        attemptID: "uncertain",
        tokens: 100,
      })
      state.cleanup = state.rival.db
        .run("CREATE TABLE cleanup_after_transaction (id INTEGER)")
        .pipe(Effect.orDie, Effect.asVoid)
      yield* h.execution.resume(run.session_id).pipe(Effect.exit, Effect.forkChild)
      yield* Deferred.await(state.started[0]!)
      yield* h.database.db
        .run(
          "CREATE TRIGGER fail_cancel BEFORE UPDATE OF cancelled_seq ON session_input BEGIN SELECT RAISE(ABORT, 'cancel failure'); END",
        )
        .pipe(Effect.orDie)
      expect(Exit.isFailure(yield* h.tidy.cancel(run.id).pipe(Effect.exit))).toBe(true)
      expect(state.finished).toEqual([0])
      expect((yield* h.execution.active).size).toBe(0)
      expect(yield* h.sessions.pendingInputs(run.session_id)).toHaveLength(1)
      expect((yield* h.tidy.get(run.id)).usage.reserved).toBe(100)
      yield* h.database.db.run("DROP TRIGGER fail_cancel").pipe(Effect.orDie)
      yield* h.tidy.cancel(run.id)
      expect(yield* h.sessions.pendingInputs(run.session_id)).toHaveLength(0)
      expect((yield* h.tidy.get(run.id)).usage.reserved).toBe(100)
    }),
  ))

test("binding read and PromptCancelled projection hold one writer against another connection", () =>
  withHost((h, state) =>
    Effect.gen(function* () {
      const run = (yield* h.tidy.prepare(request)).run
      const cancel = h.sessions.cancelInput
      let checked = false
      // Probe the old read/write gap after identity validation and immediately before projection.
      Object.defineProperty(h.sessions, "cancelInput", {
        value: (input: Parameters<typeof cancel>[0]) =>
          Effect.gen(function* () {
            const outcome = yield* state.rival.db
              .delete(SessionTable)
              .where(eq(SessionTable.id, run.session_id))
              .run()
              .pipe(Effect.exit)
            checked = true
            expect(Exit.isFailure(outcome)).toBe(true)
            if (Exit.isFailure(outcome)) expect(Cause.pretty(outcome.cause)).toContain("locked")
            yield* cancel(input)
          }),
      })
      yield* h.tidy.cancel(run.id)
      expect(checked).toBe(true)
      expect((yield* h.sessions.get(run.session_id)).id).toBe(run.session_id)
      expect(yield* h.sessions.pendingInputs(run.session_id)).toHaveLength(0)
    }),
  ))
