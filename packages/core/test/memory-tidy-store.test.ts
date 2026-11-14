import { expect, test } from "bun:test"
import path from "node:path"
import { and, eq } from "drizzle-orm"
import { Cause, Clock, Context, DateTime, Effect, Exit, Layer } from "effect"
import { adjust } from "effect/testing/TestClock"
import { Memory } from "@zaovra-ai/schema/memory"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { MemoryTidyStore } from "@zaovra-ai/core/memory/tidy-store"
import { MemoryTidyRunTable } from "@zaovra-ai/core/memory/tidy.sql"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { Project } from "@zaovra-ai/core/project"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { AbsolutePath, RelativePath } from "@zaovra-ai/core/schema"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionProjector } from "@zaovra-ai/core/session/projector"
import { SessionInput } from "@zaovra-ai/core/session/input"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionSchema } from "@zaovra-ai/core/session/schema"
import { SessionTable } from "@zaovra-ai/core/session/sql"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, MemoryTidyStore.node, EventV2.node, SessionProjector.node])),
)
const scope = Memory.Scope.make("tidy-project")
const model = { id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") }
const request: MemoryTidyStore.Request = {
  requestID: "confirmed-click",
  scope,
  directory: "/tidy-project",
  model,
  tokens: 200,
  dailyTokens: 300,
}

const host = Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const store = yield* MemoryTidyStore.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const create = (sessionID: SessionSchema.ID) =>
    events
      .publish(SessionEvent.Created, {
        sessionID,
        timestamp: DateTime.makeUnsafe(0),
        projectID: Project.ID.global,
        location: { directory: AbsolutePath.make(request.directory) },
        subpath: RelativePath.make("tidy-project"),
        title: "Tidy",
        slug: "tidy",
        version: "test",
        model,
      })
      .pipe(
        Effect.andThen(
          SessionInput.admit(database.db, events, {
            id: SessionMessage.ID.create(),
            sessionID,
            prompt: { text: "Tidy" },
            delivery: "steer",
          }),
        ),
        Effect.map((input) => ({ id: input.id, seq: input.admittedSeq })),
      )
  return { store, create, database, events }
})
const authority = (run: MemoryTidyStore.Run) => ({ sessionID: run.session_id, scope: run.scope, enabled: true })

for (const nested of [false, true])
  test(`a stale reservation rolls back as busy and a fresh retry rechecks the budget: nested=${nested}`, async () => {
    await using temporary = await tmpdir()
    const open = () =>
      AppNodeBuilder.build(
        LayerNode.group([Database.node, MemoryTidyStore.node, EventV2.node, SessionProjector.node]),
        [[Database.node, Database.layerFromPath(path.join(temporary.path, "conflict.sqlite"))]],
      )
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* Layer.build(open())
        const second = yield* Layer.build(open())
        const h = yield* host.pipe(Effect.provide(first))
        const other = Context.get(second, MemoryTidyStore.Service)
        expect(Context.get(first, Database.Service)).not.toBe(Context.get(second, Database.Service))
        const run = yield* h.store.create(request, h.create)
        const clock = yield* Clock.Clock
        let interleavings = 0
        let admitted = false
        // Arrange a real second-connection commit after the first connection's
        // authorization read. Keep SQL, transactions and wall time unchanged.
        const scheduled = Object.create(clock, {
          currentTimeMillis: {
            value: Effect.promise(() => {
              interleavings += 1
              return Effect.runPromise(other.reserve({ ...authority(run), attemptID: "winner", tokens: 150 }))
            }).pipe(Effect.andThen(clock.currentTimeMillis)),
          },
        })
        const reserve = h.store.reserve({ ...authority(run), attemptID: "loser", tokens: 150 })
        const attempt = nested
          ? h.database.db.transaction(() => reserve).pipe(Effect.catchTag("SqlError", Effect.die))
          : reserve
        const result = yield* attempt.pipe(
          Effect.provideService(Clock.Clock, scheduled),
          Effect.tap(() =>
            Effect.sync(() => {
              admitted = true
            }),
          ),
          Effect.exit,
        )
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expect(Cause.hasDies(result.cause)).toBe(false)
          expect(Cause.findErrorOption(result.cause)).toMatchObject({ value: { reason: "busy" } })
        }
        expect(admitted).toBe(false)
        expect(interleavings).toBe(1)
        expect(yield* h.store.usage({ runID: run.id })).toEqual({ known: 0, reserved: 150, charged: 150, unknown: 1 })
        expect((yield* reserve.pipe(Effect.flip)).reason).toBe("limit")
        // The rejected attempt has no row and its ID is safe to use on a fresh request.
        yield* h.store.reserve({ ...authority(run), attemptID: "loser", tokens: 50 })
        expect((yield* h.store.usage({ runID: run.id })).charged).toBe(200)
        yield* other.finish(run.id, "cancelled")
        expect(
          (yield* h.store.reserve({ ...authority(run), attemptID: "after-cancel", tokens: 1 }).pipe(Effect.flip))
            .reason,
        ).toBe("unauthorized")
      }).pipe(Effect.scoped),
    )
  })

test("a settlement conflict retains unknown usage until an explicit successful settlement", async () => {
  await using temporary = await tmpdir()
  const open = () =>
    AppNodeBuilder.build(LayerNode.group([Database.node, MemoryTidyStore.node, EventV2.node, SessionProjector.node]), [
      [Database.node, Database.layerFromPath(path.join(temporary.path, "settlement.sqlite"))],
    ])
  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Layer.build(open())
      const second = yield* Layer.build(open())
      const h = yield* host.pipe(Effect.provide(first))
      const other = Context.get(second, MemoryTidyStore.Service)
      const run = yield* h.store.create(request, h.create)
      yield* h.store.reserve({ ...authority(run), attemptID: "late", tokens: 150 })
      const clock = yield* Clock.Clock
      const scheduled = Object.create(clock, {
        currentTimeMillis: {
          value: Effect.promise(() => Effect.runPromise(other.finish(run.id, "cancelled"))).pipe(
            Effect.andThen(clock.currentTimeMillis),
          ),
        },
      })
      const result = yield* h.store.settle("late", 30).pipe(Effect.provideService(Clock.Clock, scheduled), Effect.flip)
      expect(result.reason).toBe("busy")
      expect(yield* h.store.usage({ runID: run.id })).toEqual({ known: 0, reserved: 150, charged: 150, unknown: 1 })
      expect(yield* h.store.settle("late", 30)).toEqual({ exceeded: false })
      expect(yield* h.store.usage({ runID: run.id })).toEqual({ known: 30, reserved: 0, charged: 30, unknown: 0 })
      expect((yield* h.store.get(run.id))?.state).toBe("cancelled")
    }).pipe(Effect.scoped),
  )
})

it.effect("non-lock database defects remain visible rather than becoming busy", () =>
  Effect.gen(function* () {
    const h = yield* host
    const run = yield* h.store.create(request, h.create)
    yield* h.database.db.run("drop table memory_tidy_attempt").pipe(Effect.orDie)
    const result = yield* h.store
      .reserve({ ...authority(run), attemptID: "broken-schema", tokens: 1 })
      .pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.hasDies(result.cause)).toBe(true)
      expect(Cause.hasFails(result.cause)).toBe(false)
    }
  }),
)

test("SessionV2.create and a grant share the real host transaction", async () => {
  await using temporary = await tmpdir()
  await Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const store = yield* MemoryTidyStore.Service
      const input = { ...request, directory: temporary.path }
      const run = yield* store.create(input, (id) =>
        Effect.gen(function* () {
          yield* sessions.create({ id, model, location: { directory: AbsolutePath.make(temporary.path) } })
          const admitted = yield* sessions
            .prompt({ sessionID: id, resume: false, prompt: { text: "Tidy" } })
            .pipe(Effect.orDie)
          return { id: admitted.id, seq: admitted.admittedSeq }
        }),
      )
      expect((yield* sessions.get(run.session_id)).model).toEqual({
        ...model,
        variant: ModelV2.VariantID.make("default"),
      })
      expect((yield* store.authorize(authority(run))).id).toBe(run.id)
      yield* sessions.remove(run.session_id)
      expect((yield* store.get(run.id))?.state).toBe("cancelled")
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([MemoryTidyStore.node, SessionV2.node]), [
          [SessionExecution.node, SessionExecution.noopLayer],
        ]),
      ),
      Effect.scoped,
    ),
  )
})

test("reopening the database retains unknown reservations and the original grant identity", async () => {
  await using temporary = await tmpdir()
  const reopen = () =>
    AppNodeBuilder.build(LayerNode.group([Database.node, MemoryTidyStore.node, EventV2.node, SessionProjector.node]), [
      [Database.node, Database.layerFromPath(path.join(temporary.path, "tidy.sqlite"))],
    ])
  const first = await Effect.runPromise(
    Effect.gen(function* () {
      const h = yield* host
      const run = yield* h.store.create(request, h.create)
      yield* h.store.reserve({ ...authority(run), attemptID: "disconnected", tokens: 160 })
      return run
    }).pipe(Effect.provide(reopen()), Effect.scoped),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const h = yield* host
      const retry = yield* h.store.create(request, () => Effect.die("must not create after restart"))
      expect(retry).toEqual(first)
      expect(yield* h.store.usage({ runID: first.id })).toEqual({ known: 0, reserved: 160, charged: 160, unknown: 1 })
      expect(
        (yield* h.store.reserve({ ...authority(first), attemptID: "new", tokens: 160 }).pipe(Effect.flip)).reason,
      ).toBe("limit")
      yield* h.store.settle("disconnected", 30)
      expect(yield* h.store.usage({ runID: first.id })).toEqual({ known: 30, reserved: 0, charged: 30, unknown: 0 })
    }).pipe(Effect.provide(reopen()), Effect.scoped),
  )
})

it.effect("a later task cannot increase an already used daily limit", () =>
  Effect.gen(function* () {
    const h = yield* host
    const first = yield* h.store.create({ ...request, dailyTokens: 150 }, h.create)
    yield* h.store.reserve({ ...authority(first), attemptID: "one", tokens: 100 })
    const second = yield* h.store.create(
      { ...request, scope: Memory.Scope.user, requestID: "higher", dailyTokens: 1000 },
      h.create,
    )
    expect(
      (yield* h.store.reserve({ ...authority(second), attemptID: "two", tokens: 100 }).pipe(Effect.flip)).reason,
    ).toBe("limit")
    yield* h.store.reserve({ ...authority(second), attemptID: "two", tokens: 50 })
  }),
)

it.effect("a confirmed request creates one new Session and grant; exact retry never recreates it", () =>
  Effect.gen(function* () {
    const h = yield* host
    const first = yield* h.store.create(request, h.create)
    const retry = yield* h.store.create(request, () => Effect.die("must not recreate"))
    expect(retry).toEqual(first)
    expect(
      yield* h.store.create({ ...request, model: { ...model, variant: ModelV2.VariantID.make("default") } }, () =>
        Effect.die("default variant must not recreate"),
      ),
    ).toEqual(first)
    expect(yield* h.store.authorize(authority(first))).toEqual(first)
    const conflict = yield* h.store.create({ ...request, tokens: 201 }, h.create).pipe(Effect.flip)
    expect(conflict.reason).toBe("conflict")
    expect(yield* h.database.db.select().from(MemoryTidyRunTable).all().pipe(Effect.orDie)).toHaveLength(1)
    expect(yield* h.database.db.select().from(SessionTable).all().pipe(Effect.orDie)).toHaveLength(1)
  }),
)

it.effect("failed host creation rolls back both Session projection and grant", () =>
  Effect.gen(function* () {
    const h = yield* host
    const result = yield* h.store
      .create(request, (id) => h.create(id).pipe(Effect.andThen(Effect.die("interrupted creation"))))
      .pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
    expect(yield* h.database.db.select().from(SessionTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect(yield* h.database.db.select().from(MemoryTidyRunTable).all().pipe(Effect.orDie)).toHaveLength(0)
    expect((yield* h.store.create(request, h.create)).state).toBe("active")
  }),
)

it.effect("ordinary Session, wrong scope, disabled memory and changed model cannot authorize", () =>
  Effect.gen(function* () {
    const h = yield* host
    const ordinary = SessionSchema.ID.create()
    yield* h.create(ordinary)
    expect((yield* h.store.authorize({ sessionID: ordinary, scope, enabled: true }).pipe(Effect.flip)).reason).toBe(
      "unauthorized",
    )
    const run = yield* h.store.create(request, h.create)
    for (const input of [
      { ...authority(run), scope: Memory.Scope.user },
      { ...authority(run), enabled: false },
    ])
      expect((yield* h.store.authorize(input).pipe(Effect.flip)).reason).toBe("unauthorized")
    yield* h.database.db
      .update(SessionTable)
      .set({ model: { ...model, id: ModelV2.ID.make("other") } })
      .where(eq(SessionTable.id, run.session_id))
      .run()
      .pipe(Effect.orDie)
    expect((yield* h.store.authorize(authority(run)).pipe(Effect.flip)).reason).toBe("unauthorized")
  }),
)

it.effect("concurrent attempts compete for one durable allowance and IDs cannot be replayed", () =>
  Effect.gen(function* () {
    const h = yield* host
    const run = yield* h.store.create(request, h.create)
    const results = yield* Effect.forEach(
      ["one", "two"],
      (attemptID) =>
        h.store.reserve({ ...authority(run), attemptID, tokens: 150 }).pipe(
          Effect.as("accepted"),
          Effect.catchTag("MemoryTidy.Rejected", (error) => Effect.succeed(error.reason)),
        ),
      { concurrency: "unbounded" },
    )
    expect(results.toSorted()).toEqual(["accepted", "limit"])
    expect(yield* h.store.usage({ runID: run.id })).toEqual({ known: 0, reserved: 150, charged: 150, unknown: 1 })
    const accepted = results[0] === "accepted" ? "one" : "two"
    expect(
      (yield* h.store.reserve({ ...authority(run), attemptID: accepted, tokens: 150 }).pipe(Effect.flip)).reason,
    ).toBe("duplicate")
    yield* h.store.settle(accepted, 40)
    yield* h.store.reserve({ ...authority(run), attemptID: "retry-new-id", tokens: 150 })
    expect(yield* h.store.usage({ runID: run.id })).toEqual({ known: 40, reserved: 150, charged: 190, unknown: 1 })
  }),
)

it.effect("daily allowance spans runs; crossing UTC day never releases a run's unknown reservation", () =>
  Effect.gen(function* () {
    const h = yield* host
    const first = yield* h.store.create(request, h.create)
    const second = yield* h.store.create({ ...request, scope: Memory.Scope.user, requestID: "second" }, h.create)
    const day = new Date(yield* Clock.currentTimeMillis).toISOString().slice(0, 10)
    yield* h.store.reserve({ ...authority(first), attemptID: "first", tokens: 160 })
    expect(
      (yield* h.store.reserve({ ...authority(second), attemptID: "second", tokens: 160 }).pipe(Effect.flip)).reason,
    ).toBe("limit")
    yield* adjust("24 hours")
    yield* h.store.reserve({ ...authority(second), attemptID: "second", tokens: 160 })
    expect(
      (yield* h.store.reserve({ ...authority(first), attemptID: "first-retry", tokens: 160 }).pipe(Effect.flip)).reason,
    ).toBe("limit")
    expect(yield* h.store.usage({ day })).toEqual({ known: 0, reserved: 160, charged: 160, unknown: 1 })
    expect(yield* h.store.usage({ runID: first.id })).toEqual({ known: 0, reserved: 160, charged: 160, unknown: 1 })
  }),
)

it.effect("cancellation preserves unknown usage; late settlement is idempotent but never reauthorizes", () =>
  Effect.gen(function* () {
    const h = yield* host
    const run = yield* h.store.create(request, h.create)
    yield* h.store.reserve({ ...authority(run), attemptID: "late", tokens: 150 })
    yield* h.store.finish(run.id, "cancelled")
    expect((yield* h.store.create(request, h.create)).state).toBe("cancelled")
    expect((yield* h.store.authorize(authority(run)).pipe(Effect.flip)).reason).toBe("unauthorized")
    expect((yield* h.store.usage({ runID: run.id })).reserved).toBe(150)
    expect(yield* h.store.settle("late", 40)).toEqual({ exceeded: false })
    expect(yield* h.store.settle("late", 40)).toEqual({ exceeded: false })
    expect((yield* h.store.settle("late", 41).pipe(Effect.flip)).reason).toBe("conflict")
    expect(yield* h.store.usage({ runID: run.id })).toEqual({ known: 40, reserved: 0, charged: 40, unknown: 0 })
    expect((yield* h.store.authorize(authority(run)).pipe(Effect.flip)).reason).toBe("unauthorized")
  }),
)

it.effect("an exceeded reservation is recorded truthfully and disables the task", () =>
  Effect.gen(function* () {
    const h = yield* host
    const run = yield* h.store.create(request, h.create)
    yield* h.store.reserve({ ...authority(run), attemptID: "above", tokens: 150 })
    expect(yield* h.store.settle("above", 201)).toEqual({ exceeded: true })
    expect((yield* h.store.get(run.id))?.state).toBe("failed")
    const failed = yield* h.store.get(run.id)
    yield* adjust("1 second")
    expect(yield* h.store.settle("above", 201)).toEqual({ exceeded: true })
    expect(yield* h.store.get(run.id)).toEqual(failed)
    expect((yield* h.store.usage({ runID: run.id })).charged).toBe(201)
    expect((yield* h.store.reserve({ ...authority(run), attemptID: "more", tokens: 1 }).pipe(Effect.flip)).reason).toBe(
      "unauthorized",
    )
  }),
)

it.effect("Session deletion invalidates the grant even when an ordinary Session reuses its ID", () =>
  Effect.gen(function* () {
    const h = yield* host
    const run = yield* h.store.create(request, h.create)
    yield* h.store.reserve({ ...authority(run), attemptID: "unreported", tokens: 100 })
    yield* h.events.publish(SessionEvent.Deleted, { sessionID: run.session_id, timestamp: DateTime.makeUnsafe(1) })
    expect((yield* h.store.get(run.id))?.state).toBe("cancelled")
    yield* h.create(run.session_id)
    expect((yield* h.store.authorize(authority(run)).pipe(Effect.flip)).reason).toBe("unauthorized")
    expect((yield* h.store.usage({ runID: run.id })).reserved).toBe(100)
  }),
)

it.effect("a guarded change cannot run after cancellation", () =>
  Effect.gen(function* () {
    const h = yield* host
    const run = yield* h.store.create(request, h.create)
    yield* h.store.finish(run.id, "cancelled")
    const failure = yield* h.store
      .guarded(
        authority(run),
        h.database.db
          .update(SessionTable)
          .set({ title: "must not change" })
          .where(and(eq(SessionTable.id, run.session_id), eq(SessionTable.title, "Tidy")))
          .run()
          .pipe(Effect.orDie),
      )
      .pipe(Effect.flip)
    expect(failure.reason).toBe("unauthorized")
    const session = yield* h.database.db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, run.session_id))
      .get()
      .pipe(Effect.orDie)
    expect(session?.title).toBe("Tidy")
  }),
)

it.effect("one active writer per scope; exact retries and terminal history stay addressable", () =>
  Effect.gen(function* () {
    const h = yield* host
    const first = yield* h.store.create(request, h.create)
    const rejected = yield* h.store
      .create({ ...request, requestID: "another-window" }, () =>
        Effect.die("must reject before creating another session"),
      )
      .pipe(Effect.flip)
    expect(rejected.reason).toBe("busy")
    expect((yield* h.store.create(request, () => Effect.die("must not duplicate"))).id).toBe(first.id)
    expect((yield* h.store.forSession(first.session_id))?.id).toBe(first.id)
    expect(yield* h.store.forSession(SessionSchema.ID.create())).toBeUndefined()
    expect((yield* h.store.list(request.scope)).map((run) => run.id)).toEqual([first.id])
    expect(yield* h.store.list(Memory.Scope.user)).toEqual([])
    yield* h.store.finish(first.id, "cancelled")
    const next = yield* h.store.create({ ...request, requestID: "another-window" }, h.create)
    expect(next.id).not.toBe(first.id)
    expect((yield* h.store.list(request.scope)).map((run) => run.state).sort()).toEqual(["active", "cancelled"])
    expect((yield* h.store.forSession(first.session_id))?.state).toBe("cancelled")
  }),
)

test("two database connections cannot commit simultaneous writers for one scope", async () => {
  await using temporary = await tmpdir()
  const open = () =>
    AppNodeBuilder.build(LayerNode.group([Database.node, MemoryTidyStore.node, EventV2.node, SessionProjector.node]), [
      [Database.node, Database.layerFromPath(path.join(temporary.path, "writers.sqlite"))],
    ])
  await Effect.runPromise(
    Effect.gen(function* () {
      const first = yield* Layer.build(open())
      const second = yield* Layer.build(open())
      const a = yield* host.pipe(Effect.provide(first))
      const b = yield* host.pipe(Effect.provide(second))
      const results = yield* Effect.all(
        [a.store.create(request, a.create), b.store.create({ ...request, requestID: "other-window" }, b.create)].map(
          (operation) =>
            operation.pipe(
              Effect.map((run) => ({ state: "accepted", id: run.id })),
              Effect.catchTag("MemoryTidy.Rejected", (error) => Effect.succeed({ state: error.reason, id: "" })),
            ),
        ),
        { concurrency: "unbounded" },
      )
      expect(results.filter((result) => result.state === "accepted")).toHaveLength(1)
      expect(results.filter((result) => result.state === "busy")).toHaveLength(1)
      expect(yield* a.store.list(request.scope)).toHaveLength(1)
      const sessions = yield* a.database.db.select().from(SessionTable).all().pipe(Effect.orDie)
      expect(sessions).toHaveLength(1)
    }).pipe(Effect.scoped),
  )
})

it.effect("taking the writer role does not replay or disguise a non-SQL host defect", () =>
  Effect.gen(function* () {
    const h = yield* host
    const defect = new Error("host programming failure")
    let called = 0
    const result = yield* h.store
      .create(request, () =>
        Effect.sync(() => {
          called++
        }).pipe(Effect.andThen(Effect.die(defect))),
      )
      .pipe(Effect.exit)
    expect(called).toBe(1)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.squash(result.cause)).toBe(defect)
      expect(Cause.hasFails(result.cause)).toBe(false)
    }
    expect(yield* h.store.list(request.scope)).toEqual([])
    expect(yield* h.database.db.select().from(SessionTable).all().pipe(Effect.orDie)).toEqual([])
  }),
)
