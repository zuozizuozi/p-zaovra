// Regression scenarios originally reproduced by the independent task-28 audit.
import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Exit, Layer, Scope } from "effect"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { MemoryTidy } from "../src/memory/tidy"
import { MemoryTidyStore } from "../src/memory/tidy-store"
import { MemoryTidyRunTable } from "../src/memory/tidy.sql"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionInputTable, SessionTable } from "../src/session/sql"
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
    config: yield* Config.Service,
  }
})

async function withTidy(
  body: (
    h: Effect.Success<typeof setup>,
    state: { enabled: boolean; actions: string[] },
  ) => Effect.Effect<void, unknown, Scope.Scope>,
) {
  await using tmp = await tmpdir()
  const state = { enabled: true, actions: [] as string[] }
  let store: MemoryTidyStore.Interface
  await Effect.runPromise(
    Effect.gen(function* () {
      const h = yield* setup
      store = h.store
      yield* body(h, state)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([MemoryTidy.node, MemoryTidyStore.node, SessionV2.node, Database.node, Config.node]),
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
            [
              Config.node,
              Layer.succeed(Config.Service, {
                entries: () =>
                  Effect.sync(() => [
                    new Config.Document({
                      type: "document",
                      info: new Config.Info({ memory: { enabled: state.enabled } }),
                    }),
                  ]),
              }),
            ],
            [
              SessionExecution.node,
              Layer.succeed(SessionExecution.Service, {
                active: Effect.succeed(new Set<SessionV2.ID>()),
                wake: () =>
                  Effect.sync(() => {
                    state.actions.push("wake")
                  }),
                resume: () =>
                  Effect.sync(() => {
                    state.actions.push("resume")
                  }),
                interrupt: (id, cleanup) =>
                  Effect.gen(function* () {
                    state.actions.push(`interrupt:${(yield* store.forSession(id))?.state}`)
                    yield* cleanup ?? Effect.void
                  }),
              }),
            ],
          ],
        ),
      ),
      Effect.scoped,
    ),
  )
}

test("audit late grant insert failure rolls back durable prompt as well as Session", () =>
  withTidy((h, state) =>
    Effect.gen(function* () {
      yield* h.database.db
        .run(
          "CREATE TRIGGER audit_fail_grant AFTER INSERT ON memory_tidy_run BEGIN SELECT RAISE(ABORT, 'late grant failure'); END",
        )
        .pipe(Effect.orDie)
      expect(Exit.isFailure(yield* h.tidy.prepare(request).pipe(Effect.exit))).toBe(true)
      expect(yield* h.database.db.select().from(SessionTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* h.database.db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* h.database.db.select().from(MemoryTidyRunTable).all().pipe(Effect.orDie)).toEqual([])
      expect(state.actions).toEqual([])
      yield* h.database.db.run("DROP TRIGGER audit_fail_grant").pipe(Effect.orDie)
      const retry = yield* h.tidy.prepare(request)
      expect(yield* h.sessions.pendingInputs(retry.run.session_id)).toHaveLength(1)
    }),
  ))
test("audit cancelled task retries pending cleanup after a transient cancellation failure", () =>
  withTidy((h, state) =>
    Effect.gen(function* () {
      const run = (yield* h.tidy.prepare(request)).run
      yield* h.store.reserve({
        sessionID: run.session_id,
        scope: run.scope,
        enabled: true,
        attemptID: "unknown",
        tokens: 100,
      })
      yield* h.database.db
        .run(
          "CREATE TRIGGER audit_fail_cancel BEFORE UPDATE OF cancelled_seq ON session_input BEGIN SELECT RAISE(ABORT, 'cancel storage failure'); END",
        )
        .pipe(Effect.orDie)
      expect(Exit.isFailure(yield* h.tidy.cancel(run.id).pipe(Effect.exit))).toBe(true)
      expect((yield* h.store.get(run.id))?.state).toBe("cancelled")
      expect(yield* h.sessions.pendingInputs(run.session_id)).toHaveLength(1)
      yield* h.database.db.run("DROP TRIGGER audit_fail_cancel").pipe(Effect.orDie)
      const retry = yield* h.tidy.cancel(run.id)
      expect(retry.run.state).toBe("cancelled")
      expect(retry.usage.reserved).toBe(100)
      console.log(
        "AUDIT_CANCEL_RETRY",
        JSON.stringify({
          pending: (yield* h.sessions.pendingInputs(run.session_id)).length,
          actions: state.actions,
          state: retry.run.state,
        }),
      )
      expect(yield* h.sessions.pendingInputs(run.session_id)).toHaveLength(0)
    }),
  ))
test("audit old cancel cannot alter a reused ordinary Session or a fresh scope task", () =>
  withTidy((h) =>
    Effect.gen(function* () {
      const run = (yield* h.tidy.prepare(request)).run
      yield* h.store.reserve({
        sessionID: run.session_id,
        scope: run.scope,
        enabled: true,
        attemptID: "late",
        tokens: 100,
      })
      const old = yield* h.sessions.get(run.session_id)
      yield* h.sessions.remove(run.session_id)
      yield* h.sessions.create({ id: run.session_id, model, location: old.location })
      expect(run.input).not.toBeNull()
      yield* h.sessions.prompt({
        id: run.input!.id,
        sessionID: run.session_id,
        resume: false,
        prompt: { text: "ordinary pending" },
      })
      expect((yield* h.sessions.pendingInputs(run.session_id))[0]?.admittedSeq).not.toBe(run.input!.seq)
      const next = yield* h.tidy.prepare({ ...request, requestID: "fresh" })
      yield* h.tidy.cancel(run.id)
      expect(yield* h.sessions.pendingInputs(run.session_id)).toHaveLength(1)
      expect((yield* h.tidy.get(next.run.id)).run.state).toBe("active")
      expect((yield* h.tidy.prepare(request)).run.state).toBe("cancelled")
      expect(
        (yield* h.store.authorize({ sessionID: run.session_id, scope: run.scope, enabled: true }).pipe(Effect.flip))
          .reason,
      ).toBe("unauthorized")
      yield* h.store.settle("late", 30)
      expect((yield* h.tidy.get(run.id)).usage).toEqual({ known: 30, reserved: 0, charged: 30, unknown: 0 })
    }),
  ))
test("audit two host connections serialize writers and exact retry survives reopen with scope isolation", async () => {
  await using tmp = await tmpdir()
  const open = () =>
    AppNodeBuilder.build(
      LayerNode.group([MemoryTidy.node, MemoryTidyStore.node, SessionV2.node, Database.node, Config.node]),
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
        [SessionExecution.node, SessionExecution.noopLayer],
      ],
    )
  const saved = await Effect.runPromise(
    Effect.gen(function* () {
      const a = yield* Layer.build(open())
      const b = yield* Layer.build(open())
      const first = yield* setup.pipe(Effect.provide(a))
      const second = yield* setup.pipe(Effect.provide(b))
      expect(first.database).not.toBe(second.database)
      const results = yield* Effect.all(
        [first.tidy.prepare(request), second.tidy.prepare({ ...request, requestID: "other-window" })].map((op) =>
          op.pipe(
            Effect.map((value) => ({ value })),
            Effect.catchTag("MemoryTidy.Rejected", (error) => Effect.succeed({ error: error.reason })),
          ),
        ),
        { concurrency: 2 },
      )
      expect(results.filter((x) => "value" in x)).toHaveLength(1)
      expect(results.filter((x) => "error" in x).map((x) => ("error" in x ? x.error : undefined))).toEqual(["busy"])
      expect(yield* first.database.db.select().from(SessionTable).all().pipe(Effect.orDie)).toHaveLength(1)
      const winner = results.find((x) => "value" in x)
      if (!winner || !("value" in winner)) throw new Error("no winner")
      const run = winner.value.run
      const user = yield* second.tidy.prepare({ ...request, requestID: "user", layer: "user" })
      expect((yield* first.tidy.get(user.run.id).pipe(Effect.flip)).reason).toBe("missing")
      expect((yield* first.tidy.cancel(run.id, "user").pipe(Effect.flip)).reason).toBe("missing")
      expect((yield* first.tidy.list()).map((x) => x.run.id)).toEqual([run.id])
      expect((yield* second.tidy.list("user")).map((x) => x.run.id)).toEqual([user.run.id])
      return run
    }).pipe(Effect.scoped),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const h = yield* setup
      const retry = yield* h.tidy.prepare({ ...request, requestID: saved.request_id })
      expect(retry.run).toEqual(saved)
      expect(yield* h.sessions.pendingInputs(saved.session_id)).toHaveLength(1)
      expect((yield* h.store.forSession(saved.session_id))?.id).toBe(saved.id)
      expect(
        (yield* h.tidy.prepare({ ...request, requestID: saved.request_id, tokens: 1 }).pipe(Effect.flip)).reason,
      ).toBe("conflict")
    }).pipe(Effect.provide(open()), Effect.scoped),
  )
})
