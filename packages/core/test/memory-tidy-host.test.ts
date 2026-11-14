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
import { SessionBudget } from "../src/session/budget"
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

test("host preparation atomically admits one task and never wakes an unbudgeted provider", () =>
  withTidy((h, state) =>
    Effect.gen(function* () {
      const first = yield* h.tidy.prepare(request)
      const retry = yield* h.tidy.prepare(request)
      expect(retry).toEqual(first)
      expect(first.run.model).toEqual(model)
      expect(first.run.token_limit).toBe(200_000)
      expect(first.run.daily_limit).toBe(1_000_000)
      expect(first.usage).toEqual({ known: 0, reserved: 0, charged: 0, unknown: 0 })
      expect(first.executing).toBe(false)
      const session = yield* h.sessions.get(first.run.session_id)
      expect(session.model?.id).toBe(model.id)
      expect((yield* SessionBudget.read(h.database.db, h.config, first.run.session_id)).limit).toBe(200_000)
      const pending = yield* h.sessions.pendingInputs(first.run.session_id)
      expect(pending).toHaveLength(1)
      expect(state.actions).toEqual([])
      expect(yield* h.tidy.list()).toEqual([first])
    }),
  ))

test("disabled preparation creates no Session or grant and is rechecked for every click", () =>
  withTidy((h, state) =>
    Effect.gen(function* () {
      state.enabled = false
      expect((yield* h.tidy.prepare(request).pipe(Effect.flip)).reason).toBe("unauthorized")
      expect(yield* h.tidy.list()).toEqual([])
      expect(yield* h.database.db.select().from(SessionTable).all().pipe(Effect.orDie)).toEqual([])
      state.enabled = true
      const first = yield* h.tidy.prepare(request)
      state.enabled = false
      expect((yield* h.tidy.prepare(request).pipe(Effect.flip)).reason).toBe("unauthorized")
      expect((yield* h.tidy.get(first.run.id)).run.id).toBe(first.run.id)
      yield* h.tidy.cancel(first.run.id)
      expect(state.actions).toEqual(["interrupt:cancelled"])
    }),
  ))

test("scope boundaries and duplicate windows are enforced before another Session is created", () =>
  withTidy((h) =>
    Effect.gen(function* () {
      const project = yield* h.tidy.prepare(request)
      expect((yield* h.tidy.prepare({ ...request, requestID: "second-window" }).pipe(Effect.flip)).reason).toBe("busy")
      const user = yield* h.tidy.prepare({ ...request, requestID: "global-click", layer: "user" })
      expect((yield* h.tidy.get(project.run.id, "user").pipe(Effect.flip)).reason).toBe("missing")
      expect((yield* h.tidy.cancel(user.run.id).pipe(Effect.flip)).reason).toBe("missing")
      expect((yield* h.tidy.list()).map((item) => item.run.id)).toEqual([project.run.id])
      expect((yield* h.tidy.list("user")).map((item) => item.run.id)).toEqual([user.run.id])
      expect(yield* h.sessions.pendingInputs(user.run.session_id)).toHaveLength(1)
      expect(yield* h.database.db.select().from(SessionTable).all().pipe(Effect.orDie)).toHaveLength(2)
    }),
  ))

test("cancel revokes before interruption, retains unknown usage, and repeated clicks cannot restart", () =>
  withTidy((h, state) =>
    Effect.gen(function* () {
      const first = yield* h.tidy.prepare(request)
      yield* h.store.reserve({
        sessionID: first.run.session_id,
        scope: first.run.scope,
        enabled: true,
        attemptID: "uncertain",
        tokens: 500,
      })
      const cancelled = yield* h.tidy.cancel(first.run.id)
      expect(cancelled.run.state).toBe("cancelled")
      expect(cancelled.usage).toEqual({ known: 0, reserved: 500, charged: 500, unknown: 1 })
      expect(state.actions).toEqual(["interrupt:cancelled"])
      expect(yield* h.tidy.cancel(first.run.id)).toEqual(cancelled)
      expect(yield* h.tidy.prepare(request)).toEqual(cancelled)
      expect(state.actions).toEqual(["interrupt:cancelled"])
      expect(
        (yield* h.store
          .authorize({ sessionID: first.run.session_id, scope: first.run.scope, enabled: true })
          .pipe(Effect.flip)).reason,
      ).toBe("unauthorized")
      expect(yield* h.sessions.pendingInputs(first.run.session_id)).toHaveLength(0)
      const next = yield* h.tidy.prepare({ ...request, requestID: "fresh-click" })
      expect(next.run.id).not.toBe(first.run.id)
    }),
  ))

test("conflicting retry parameters fail without altering the original task", () =>
  withTidy((h) =>
    Effect.gen(function* () {
      const original = yield* h.tidy.prepare(request)
      expect((yield* h.tidy.prepare({ ...request, tokens: 1 }).pipe(Effect.flip)).reason).toBe("conflict")
      expect(
        (yield* h.tidy.prepare({ ...request, model: { ...model, id: ModelV2.ID.make("other") } }).pipe(Effect.flip))
          .reason,
      ).toBe("conflict")
      expect(yield* h.tidy.get(original.run.id)).toEqual(original)
    }),
  ))

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

test("failed durable prompt admission rolls back the Session and grant together", () =>
  withTidy((h, state) =>
    Effect.gen(function* () {
      yield* h.database.db
        .run(
          "CREATE TRIGGER refuse_tidy_input BEFORE INSERT ON session_input BEGIN SELECT RAISE(ABORT, 'test admission failure'); END",
        )
        .pipe(Effect.orDie)
      const result = yield* h.tidy.prepare(request).pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* h.database.db.select().from(SessionTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* h.database.db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* h.database.db.select().from(MemoryTidyRunTable).all().pipe(Effect.orDie)).toEqual([])
      expect(state.actions).toEqual([])
      yield* h.database.db.run("DROP TRIGGER refuse_tidy_input").pipe(Effect.orDie)
      const retry = yield* h.tidy.prepare(request)
      expect(retry.run.state).toBe("active")
      expect(yield* h.sessions.pendingInputs(retry.run.session_id)).toHaveLength(1)
    }),
  ))
