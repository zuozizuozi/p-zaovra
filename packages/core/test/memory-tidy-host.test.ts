import { expect, test } from "bun:test"
import path from "node:path"
import { DateTime, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { eq } from "drizzle-orm"
import { Memory } from "@zaovra-ai/schema/memory"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { makeGlobalNode } from "../src/effect/app-node"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { MemoryTidy } from "../src/memory/tidy"
import { MemoryStore } from "../src/memory/store"
import { MemoryNoteTable } from "../src/memory/sql"
import { MemoryTidyStore } from "../src/memory/tidy-store"
import { MemoryTidyRunTable } from "../src/memory/tidy.sql"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionRunCoordinator } from "../src/session/run-coordinator"
import { EventV2 } from "../src/event"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { SessionInput } from "../src/session/input"
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
    memory: yield* MemoryStore.Service,
    location: yield* Location.Service,
    events: yield* EventV2.Service,
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
    state: { enabled: boolean; actions: string[]; execute?: (id: SessionV2.ID) => Effect.Effect<void> },
  ) => Effect.Effect<void, unknown, Scope.Scope>,
  platform: NodeJS.Platform = process.platform,
) {
  await using tmp = await tmpdir()
  const state: { enabled: boolean; actions: string[]; execute?: (id: SessionV2.ID) => Effect.Effect<void> } = {
    enabled: true,
    actions: [],
  }
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
            MemoryStore.node,
            SessionV2.node,
            Database.node,
            Config.node,
            Location.node,
            EventV2.node,
          ]),
          [
            [
              MemoryStore.node,
              makeGlobalNode({
                service: MemoryStore.Service,
                layer: MemoryStore.layerWith(platform),
                deps: [Database.node],
              }),
            ],
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
              Layer.effect(
                SessionExecution.Service,
                Effect.gen(function* () {
                  const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, never>({
                    drain: (id, _force, claim) =>
                      Effect.gen(function* () {
                        yield* claim?.check ?? Effect.void
                        state.actions.push("resume")
                        yield* state.execute?.(id) ?? Effect.void
                      }),
                  })
                  return {
                    active: coordinator.active,
                    wake: () =>
                      Effect.sync(() => {
                        state.actions.push("wake")
                      }),
                    resume: (id, claim) => (claim ? coordinator.owned(id, claim) : coordinator.run(id)),
                    prepareInterrupt: (id, cleanup) =>
                      coordinator.prepareInterrupt(
                        id,
                        Effect.gen(function* () {
                          state.actions.push(`interrupt:${(yield* store.forSession(id))?.state}`)
                          yield* cleanup ?? Effect.void
                        }),
                      ),
                    interrupt: (id, cleanup) =>
                      coordinator.interrupt(
                        id,
                        Effect.gen(function* () {
                          state.actions.push(`interrupt:${(yield* store.forSession(id))?.state}`)
                          yield* cleanup ?? Effect.void
                        }),
                      ),
                  } satisfies SessionExecution.Interface
                }),
              ),
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

test("legacy runs remain visible, revoke before cleanup and retain unknown charges and late receipts", () =>
  withTidy(
    (h, state) =>
      Effect.gen(function* () {
        const run = (yield* h.tidy.prepare(request)).run
        yield* h.store.reserve({
          sessionID: run.session_id,
          scope: run.scope,
          enabled: true,
          attemptID: "old-unknown",
          tokens: 500,
        })
        const old = MemoryStore.scope({ project: h.location.project.id, directory: h.location.directory }, "win32")
        // Simulate a persisted pre-upgrade task, even when its legacy note bucket is empty.
        yield* h.database.db
          .update(MemoryTidyRunTable)
          .set({ scope: old })
          .where(eq(MemoryTidyRunTable.id, run.id))
          .run()
          .pipe(Effect.orDie)
        expect(
          (yield* h.store.authorize({ sessionID: run.session_id, scope: old, enabled: true }).pipe(Effect.flip)).reason,
        ).toBe("unauthorized")
        const runs = yield* h.tidy.list()
        expect(runs).toHaveLength(1)
        expect(runs[0].run.scope).toBe(old)
        expect(runs[0].run.state).toBe("cancelled")
        expect(runs[0].usage).toEqual({ known: 0, reserved: 500, charged: 500, unknown: 1 })
        expect(state.actions).toEqual(["interrupt:cancelled"])
        expect(yield* h.sessions.pendingInputs(run.session_id)).toHaveLength(0)
        expect((yield* h.tidy.get(run.id)).run.state).toBe("cancelled")
        expect(state.actions).toEqual(["interrupt:cancelled"])
        yield* h.store.settle("old-unknown", 75)
        expect((yield* h.tidy.get(run.id)).usage).toEqual({ known: 75, reserved: 0, charged: 75, unknown: 0 })
        const next = yield* h.tidy.prepare({ ...request, requestID: "new-scope-click" })
        expect(next.run.scope).not.toBe(old)
        expect((yield* h.tidy.list()).map((view) => view.run.id)).toEqual([next.run.id, run.id])
      }),
    "linux",
  ))

test("pending recovery and opaque deletions deny admission and already admitted tool/request authority", () =>
  withTidy(
    (h) =>
      Effect.gen(function* () {
        const run = (yield* h.tidy.prepare(request)).run
        const place = { project: h.location.project.id, directory: h.location.directory }
        const old = MemoryStore.scope(place, "win32")
        yield* h.database.db
          .insert(MemoryNoteTable)
          .values({
            id: Memory.ID.make("mem_old_deleted"),
            scope: old,
            key: "old-fact-unknown",
            text: "",
            kind: "practice",
            origin: "program",
            status: "unverified",
            time_observed: 1,
            time_deleted: 1,
          })
          .run()
          .pipe(Effect.orDie)
        const authority = { sessionID: run.session_id, scope: run.scope, enabled: true }
        expect((yield* h.tidy.prepare({ ...request, requestID: "frozen-click" }).pipe(Effect.flip)).reason).toBe(
          "unauthorized",
        )
        expect(
          (yield* h.store.reserve({ ...authority, attemptID: "blocked", tokens: 10 }).pipe(Effect.flip)).reason,
        ).toBe("unauthorized")
        const touched: string[] = []
        expect(
          (yield* h.store
            .guarded(
              authority,
              Effect.sync(() => touched.push("mutated")),
            )
            .pipe(Effect.flip)).reason,
        ).toBe("unauthorized")
        expect(touched).toEqual([])
        expect(yield* h.memory.resolveRecovery(place, { decision: "blank", ids: [] })).toBe(true)
        expect((yield* h.memory.recovery(place)).frozen).toBe(false)
        expect((yield* h.memory.recovery(place)).automaticFrozen).toBe(true)
        expect((yield* h.store.authorize(authority).pipe(Effect.flip)).reason).toBe("unauthorized")
        yield* h.tidy.cancel(run.id)
        expect((yield* h.tidy.prepare({ ...request, requestID: "still-frozen" }).pipe(Effect.flip)).reason).toBe(
          "unauthorized",
        )
        expect((yield* h.tidy.prepare({ ...request, requestID: "user-independent", layer: "user" })).run.scope).toBe(
          Memory.Scope.user,
        )
      }),
    "linux",
  ))

test("legacy reconciliation cannot cancel another directory or a reused admission identity", () =>
  withTidy(
    (h, state) =>
      Effect.gen(function* () {
        const run = (yield* h.tidy.prepare(request)).run
        const old = MemoryStore.scope({ project: h.location.project.id, directory: h.location.directory }, "win32")
        yield* h.database.db
          .update(MemoryTidyRunTable)
          .set({ scope: old, directory: h.location.directory + "-other" })
          .where(eq(MemoryTidyRunTable.id, run.id))
          .run()
          .pipe(Effect.orDie)
        expect(yield* h.tidy.list()).toEqual([])
        expect((yield* h.store.get(run.id))?.state).toBe("active")
        expect(state.actions).toEqual([])
        yield* h.database.db
          .update(MemoryTidyRunTable)
          .set({ directory: h.location.directory, input: { id: run.input!.id, seq: run.input!.seq + 1 } })
          .where(eq(MemoryTidyRunTable.id, run.id))
          .run()
          .pipe(Effect.orDie)
        expect((yield* h.tidy.get(run.id)).run.state).toBe("cancelled")
        expect(state.actions).toEqual([])
        expect(yield* h.sessions.pendingInputs(run.session_id)).toHaveLength(1)
      }),
    "linux",
  ))

test("known legacy content can be confirmed blank then a fresh directory task is admitted", () =>
  withTidy(
    (h) =>
      Effect.gen(function* () {
        const place = { project: h.location.project.id, directory: h.location.directory }
        yield* h.database.db
          .insert(MemoryNoteTable)
          .values({
            id: Memory.ID.make("mem_old_live"),
            scope: MemoryStore.scope(place, "win32"),
            key: "live",
            text: "old note",
            kind: "practice",
            origin: "model",
            status: "unverified",
            time_observed: 1,
          })
          .run()
          .pipe(Effect.orDie)
        expect((yield* h.tidy.prepare(request).pipe(Effect.flip)).reason).toBe("unauthorized")
        expect(yield* h.database.db.select().from(SessionTable).all().pipe(Effect.orDie)).toEqual([])
        yield* h.memory.resolveRecovery(place, { decision: "blank", ids: [] })
        const run = (yield* h.tidy.prepare(request)).run
        expect(run.state).toBe("active")
        expect((yield* h.store.authorize({ sessionID: run.session_id, scope: run.scope, enabled: true })).id).toBe(
          run.id,
        )
      }),
    "linux",
  ))

test("explicit start is shared by repeated clicks and completes only after the owned drain settles", () =>
  withTidy((h, state) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      state.execute = (sessionID) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(ready, undefined)
          yield* Deferred.await(release)
          const pending = yield* h.sessions.pendingInputs(sessionID).pipe(Effect.orDie)
          yield* SessionInput.promoteSteers(
            h.database.db,
            h.events,
            sessionID,
            Math.max(...pending.map((input) => input.admittedSeq)),
          )
          const assistantMessageID = SessionMessage.ID.create()
          yield* h.events.publish(SessionEvent.Step.Started, {
            sessionID,
            assistantMessageID,
            model,
            agent: "build",
            timestamp: yield* DateTime.now,
          })
          yield* h.events.publish(SessionEvent.Step.Ended, {
            sessionID,
            assistantMessageID,
            finish: "stop",
            cost: 0,
            tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            timestamp: yield* DateTime.now,
          })
        })
      const prepared = yield* h.tidy.prepare(request)
      expect(prepared.executing).toBe(false)
      const starts = yield* Effect.all([h.tidy.start(prepared.run.id), h.tidy.start(prepared.run.id)], {
        concurrency: 2,
      })
      yield* Deferred.await(ready)
      expect(starts.every((view) => view.executing)).toBe(true)
      expect(state.actions).toEqual(["resume"])
      yield* Deferred.succeed(release, undefined)
      for (let n = 0; n < 100 && (yield* h.tidy.get(prepared.run.id)).executing; n++) yield* Effect.sleep("5 millis")
      expect((yield* h.tidy.get(prepared.run.id)).run.state).toBe("completed")
      expect((yield* h.tidy.start(prepared.run.id)).run.state).toBe("completed")
      expect(state.actions).toEqual(["resume"])
    }),
  ))

test("cancel interrupts an owned started task and repeat start never spends again", () =>
  withTidy((h, state) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      state.execute = () => Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never))
      const run = (yield* h.tidy.prepare(request)).run
      yield* h.tidy.start(run.id)
      yield* Deferred.await(ready)
      yield* h.store.reserve({
        sessionID: run.session_id,
        scope: run.scope,
        enabled: true,
        attemptID: "running-unknown",
        tokens: 100,
      })
      const stopped = yield* h.tidy.cancel(run.id)
      expect(stopped.run.state).toBe("cancelled")
      expect(stopped.usage.reserved).toBe(100)
      yield* h.tidy.start(run.id)
      expect(state.actions.filter((action) => action === "resume")).toHaveLength(1)
      expect(yield* h.sessions.pendingInputs(run.session_id)).toHaveLength(0)
    }),
  ))

test("failed and empty drains are not reported as completed or restarted by reads", () =>
  withTidy((h, state) =>
    Effect.gen(function* () {
      for (const mode of ["failure", "empty"] as const) {
        state.execute = () => (mode === "failure" ? Effect.die("scripted execution failure") : Effect.void)
        const run = (yield* h.tidy.prepare({ ...request, requestID: mode })).run
        yield* h.tidy.start(run.id)
        for (let n = 0; n < 100 && (yield* h.tidy.get(run.id)).executing; n++) yield* Effect.sleep("5 millis")
        expect((yield* h.tidy.get(run.id)).run.state).toBe("failed")
        yield* h.tidy.list()
        yield* h.tidy.start(run.id)
      }
      expect(state.actions).toEqual(["resume", "resume"])
    }),
  ))

test("start rechecks configuration after prepare without waking the task", () =>
  withTidy((h, state) =>
    Effect.gen(function* () {
      const run = (yield* h.tidy.prepare(request)).run
      state.enabled = false
      expect((yield* h.tidy.start(run.id).pipe(Effect.flip)).reason).toBe("unauthorized")
      expect((yield* h.tidy.get(run.id)).executing).toBe(false)
      expect(state.actions).toEqual([])
    }),
  ))
