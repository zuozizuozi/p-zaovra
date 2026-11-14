// Regression scenarios originally reproduced by the independent task-28 audit.
import { expect, test } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { EventV2 } from "../src/event"
import { SessionInput } from "../src/session/input"
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
    events: yield* EventV2.Service,
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
          LayerNode.group([
            MemoryTidy.node,
            MemoryTidyStore.node,
            SessionV2.node,
            Database.node,
            Config.node,
            EventV2.node,
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
                prepareInterrupt: (id, cleanup) =>
                  Effect.succeed(
                    Effect.gen(function* () {
                      state.actions.push(`interrupt:${(yield* store.forSession(id))?.state}`)
                      yield* cleanup ?? Effect.void
                    }),
                  ),
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

for (const mode of ["host", "database-new-input", "database-same-input"] as const)
  test(`grant cannot authorize a replaced Session incarnation: ${mode}`, () =>
    withTidy((h) =>
      Effect.gen(function* () {
        const run = (yield* h.tidy.prepare(request)).run
        const authority = { sessionID: run.session_id, scope: run.scope, enabled: true }
        yield* h.store.reserve({ ...authority, attemptID: "old-unknown", tokens: 100 })
        const original = yield* h.sessions.get(run.session_id)
        if (mode === "host") yield* h.sessions.remove(run.session_id)
        if (mode !== "host")
          yield* h.database.db.delete(SessionTable).where(eq(SessionTable.id, run.session_id)).run().pipe(Effect.orDie)
        const fresh = yield* h.sessions.create({ id: run.session_id, model, location: original.location })
        const admitted = yield* h.sessions.prompt({
          id: mode === "database-same-input" ? run.input!.id : undefined,
          sessionID: run.session_id,
          resume: false,
          prompt: { text: "new incarnation" },
        })
        expect(admitted.admittedSeq).not.toBe(run.input!.seq)
        const results = yield* Effect.all(
          [
            h.store.authorize(authority),
            h.store.guarded(
              authority,
              h.database.db
                .update(SessionTable)
                .set({ title: "unauthorized write" })
                .where(eq(SessionTable.id, run.session_id))
                .run()
                .pipe(Effect.orDie),
            ),
            h.store.reserve({ ...authority, attemptID: "new-attempt", tokens: 1 }),
          ].map((effect) =>
            effect.pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "accepted" })),
          ),
        )
        console.log(
          "GRANT_REUSE",
          JSON.stringify({
            mode,
            state: (yield* h.store.get(run.id))?.state,
            results,
            title: (yield* h.sessions.get(run.session_id)).title,
            usage: yield* h.store.usage({ runID: run.id }),
          }),
        )
        expect(results).toEqual(["unauthorized", "unauthorized", "unauthorized"])
        expect((yield* h.sessions.get(run.session_id)).title).toBe(fresh.title)
        expect(yield* h.store.usage({ runID: run.id })).toEqual({ known: 0, reserved: 100, charged: 100, unknown: 1 })
        yield* h.store.settle("old-unknown", 30)
        expect(yield* h.store.usage({ runID: run.id })).toEqual({ known: 30, reserved: 0, charged: 30, unknown: 0 })
      }),
    ))

test("NULL legacy grant is not inferred from a matching live Session", () =>
  withTidy((h) =>
    Effect.gen(function* () {
      const run = (yield* h.tidy.prepare(request)).run
      const authority = { sessionID: run.session_id, scope: run.scope, enabled: true }
      yield* h.store.reserve({ ...authority, attemptID: "legacy", tokens: 100 })
      yield* h.database.db
        .update(MemoryTidyRunTable)
        .set({ input: null })
        .where(eq(MemoryTidyRunTable.id, run.id))
        .run()
        .pipe(Effect.orDie)
      const result = yield* h.store
        .authorize(authority)
        .pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "accepted" }))
      expect(result).toBe("unauthorized")
      expect((yield* h.store.reserve({ ...authority, attemptID: "new", tokens: 1 }).pipe(Effect.flip)).reason).toBe(
        "unauthorized",
      )
      yield* h.store.finish(run.id, "cancelled")
      yield* h.store.settle("legacy", 40)
      expect((yield* h.store.usage({ runID: run.id })).known).toBe(40)
      expect((yield* h.store.get(run.id))?.input).toBeNull()
    }),
  ))

test("promoted original admission still authorizes guarded work and reservation", () =>
  withTidy((h) =>
    Effect.gen(function* () {
      const run = (yield* h.tidy.prepare(request)).run
      const authority = { sessionID: run.session_id, scope: run.scope, enabled: true }
      expect(yield* SessionInput.promoteSteers(h.database.db, h.events, run.session_id, run.input!.seq)).toBe(1)
      expect(yield* h.sessions.pendingInputs(run.session_id)).toHaveLength(0)
      expect((yield* h.store.authorize(authority)).id).toBe(run.id)
      yield* h.store.guarded(
        authority,
        h.database.db
          .update(SessionTable)
          .set({ title: "authorized" })
          .where(eq(SessionTable.id, run.session_id))
          .run()
          .pipe(Effect.orDie),
      )
      yield* h.store.reserve({ ...authority, attemptID: "normal", tokens: 30 })
      expect((yield* h.sessions.get(run.session_id)).title).toBe("authorized")
      expect((yield* h.store.usage({ runID: run.id })).reserved).toBe(30)
    }),
  ))

test("creation rejects a false admission sequence and rolls back the new Session and input", () =>
  withTidy((h) =>
    Effect.gen(function* () {
      const original = (yield* h.tidy.prepare(request)).run
      yield* h.store.finish(original.id, "cancelled")
      const result = yield* h.store
        .create(
          {
            requestID: "invalid-binding",
            scope: original.scope,
            directory: original.directory,
            model,
            tokens: 200,
            dailyTokens: 300,
          },
          (id) =>
            Effect.gen(function* () {
              yield* h.sessions.create({ id, model, location: { directory: AbsolutePath.make(original.directory) } })
              const admitted = yield* h.sessions
                .prompt({ sessionID: id, resume: false, prompt: { text: "Tidy" } })
                .pipe(Effect.orDie)
              return { id: admitted.id, seq: admitted.admittedSeq + 1 }
            }),
        )
        .pipe(Effect.flip)
      expect(result.reason).toBe("unauthorized")
      expect(yield* h.database.db.select().from(SessionTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* h.database.db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* h.database.db.select().from(MemoryTidyRunTable).all().pipe(Effect.orDie)).toHaveLength(1)
    }),
  ))
