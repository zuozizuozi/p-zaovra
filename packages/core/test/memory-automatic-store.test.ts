import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { BackgroundJob } from "../src/background-job"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { MemoryAutomaticStore } from "../src/memory/automatic-store"
import { MemoryAutomaticIdle } from "../src/memory/automatic-idle"
import { MemoryAutomaticSourceTable } from "../src/memory/automatic.sql"
import { MemoryStore } from "../src/memory/store"
import { MemoryTidyStore } from "../src/memory/tidy-store"
import { ModelV2 } from "../src/model"
import { ProjectV2 } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath, RelativePath } from "../src/schema"
import { SessionEvent } from "../src/session/event"
import { SessionExecutionStatus } from "../src/session/execution-status"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { SessionTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      MemoryAutomaticStore.node,
      MemoryStore.node,
      MemoryTidyStore.node,
      EventV2.node,
      SessionProjector.node,
      MemoryAutomaticIdle.node,
      SessionExecutionStatus.node,
      BackgroundJob.node,
    ]),
  ),
)
const model = { id: ModelV2.ID.make("offline"), providerID: ProviderV2.ID.make("offline") }
const confirmation = { requestID: "consent-1", model, tokens: 200, dailyTokens: 1000 }
const host = Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const automatic = yield* MemoryAutomaticStore.Service
  const tidy = yield* MemoryTidyStore.Service
  const memory = yield* MemoryStore.Service
  yield* database.db
    .insert(ProjectTable)
    .values({
      id: ProjectV2.ID.global,
      worktree: AbsolutePath.make("/"),
      sandboxes: [],
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const place = {
    directory: "/automatic",
    project: ProjectV2.ID.global,
    scope: yield* memory.scope({ project: ProjectV2.ID.global, directory: "/automatic" }),
  }
  const create = (id = SessionSchema.ID.create(), directory = place.directory) =>
    Effect.gen(function* () {
      yield* events.publish(SessionEvent.Created, {
        sessionID: id,
        timestamp: yield* DateTime.now,
        projectID: ProjectV2.ID.global,
        location: { directory: AbsolutePath.make(directory) },
        subpath: RelativePath.make("automatic"),
        title: "Fixture",
        slug: "fixture",
        version: "test",
        model,
      })
      return id
    })
  const turn = (sessionID: SessionSchema.ID, user = true) =>
    Effect.gen(function* () {
      const timestamp = yield* DateTime.now
      if (user)
        yield* events.publish(SessionEvent.Prompted, {
          sessionID,
          timestamp,
          messageID: SessionMessage.ID.create(),
          prompt: { text: "Work on the fixture" },
          delivery: "steer",
        })
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
  const prepare = (input: MemoryTidyStore.Request) =>
    tidy.create(input, (id) =>
      create(id).pipe(
        Effect.andThen(
          SessionInput.admit(database.db, events, {
            id: SessionMessage.ID.create(),
            sessionID: id,
            prompt: { text: "Tidy" },
            delivery: "steer",
          }),
        ),
        Effect.map((input) => ({ id: input.id, seq: input.admittedSeq })),
      ),
    )
  const claim = (generation = confirmation.requestID, idle = Effect.succeed(true)) =>
    automatic.claim(place, generation, idle, prepare)
  return { database, automatic, tidy, place, create, turn, prepare, claim }
})

it.effect("automatic idle requires one live coordinator", () =>
  Effect.gen(function* () {
    const idle = yield* MemoryAutomaticIdle.Service
    const status = yield* SessionExecutionStatus.Service
    expect(yield* idle.available()).toBe(false)
    const active = new Set<SessionSchema.ID>()
    yield* status.track(Effect.sync(() => active))
    expect(yield* idle.available()).toBe(true)
    active.add(SessionSchema.ID.create())
    expect(yield* idle.available()).toBe(false)
    active.clear()
    yield* Effect.gen(function* () {
      yield* status.track(Effect.succeed(new Set()))
      expect(yield* idle.available()).toBe(false)
    }).pipe(Effect.scoped)
    expect(yield* idle.available()).toBe(true)
  }),
)

it.effect("automatic idle rechecks coordinator activity after database reads", () =>
  Effect.gen(function* () {
    const idle = yield* MemoryAutomaticIdle.Service
    const status = yield* SessionExecutionStatus.Service
    const state = { reads: 0 }
    const active = new Set([SessionSchema.ID.create()])
    yield* status.track(Effect.sync(() => (++state.reads === 1 ? new Set() : active)))
    expect(yield* idle.available()).toBe(false)
    expect(state.reads).toBe(2)
  }),
)

it.effect("automatic idle excludes only its own admitted run; other work and background jobs block it", () =>
  Effect.gen(function* () {
    const h = yield* host
    const idle = yield* MemoryAutomaticIdle.Service
    const status = yield* SessionExecutionStatus.Service
    const jobs = yield* BackgroundJob.Service
    const events = yield* EventV2.Service
    const active = new Set<SessionSchema.ID>()
    yield* status.track(Effect.sync(() => active))
    yield* h.automatic.confirm(h.place, confirmation)
    yield* h.turn(yield* h.create())
    const run = (yield* h.claim())!
    active.add(run.session_id)
    expect(yield* idle.available()).toBe(false)
    expect(yield* idle.allows(run)).toBe(true)
    const job = yield* jobs.start({ type: "fixture", run: Effect.never })
    expect(yield* idle.allows(run)).toBe(false)
    yield* jobs.cancel(job.id)
    expect(yield* idle.allows(run)).toBe(true)
    const ordinary = yield* h.create()
    active.add(ordinary)
    expect(yield* idle.allows(run)).toBe(false)
    active.delete(ordinary)
    yield* SessionInput.admit(h.database.db, events, {
      id: SessionMessage.ID.create(),
      sessionID: ordinary,
      prompt: { text: "Pending work" },
      delivery: "steer",
    })
    expect(yield* idle.allows(run)).toBe(false)
  }),
)

it.effect("manual tidy keeps its existing execution contract when idle authority is absent", () =>
  Effect.gen(function* () {
    const h = yield* host
    const idle = yield* MemoryAutomaticIdle.Service
    const run = yield* h.prepare({ ...h.place, ...confirmation })
    expect(yield* idle.available()).toBe(false)
    expect(yield* idle.allows(run)).toBe(true)
  }),
)

it.effect("automatic consent is off by default; stale confirmations cannot re-enable or overwrite", () =>
  Effect.gen(function* () {
    const h = yield* host
    expect(yield* h.automatic.get(h.place.directory)).toBeUndefined()
    expect(yield* h.automatic.enabled).toEqual([])
    expect((yield* h.claim().pipe(Effect.flip)).reason).toBe("unauthorized")
    const initial = yield* h.automatic.confirm(h.place, confirmation)
    expect(initial.preference.enabled).toBe(true)
    expect((yield* h.automatic.confirm(h.place, confirmation)).preference).toEqual(initial.preference)
    yield* h.automatic.disable(h.place.directory, confirmation.requestID)
    expect((yield* h.automatic.confirm(h.place, confirmation)).preference.enabled).toBe(false)
    expect((yield* h.automatic.confirm(h.place, { ...confirmation, tokens: 201 }).pipe(Effect.flip)).reason).toBe(
      "conflict",
    )
    expect((yield* h.automatic.confirm(h.place, { ...confirmation, requestID: "new" }).pipe(Effect.flip)).reason).toBe(
      "conflict",
    )
  }),
)

it.effect("completed new user work triggers once; titles, assistant maintenance and deletion do not", () =>
  Effect.gen(function* () {
    const h = yield* host
    yield* h.automatic.confirm(h.place, confirmation)
    expect(yield* h.claim()).toBeUndefined()
    const source = yield* h.create()
    yield* h.turn(source)
    const run = (yield* h.claim())!
    expect(run.state).toBe("active")
    expect(yield* h.claim()).toBeUndefined()
    yield* h.tidy.finish(run.id, "completed")
    yield* h.database.db
      .update(SessionTable)
      .set({ title: "Renamed", time_updated: 99999999 })
      .where(eq(SessionTable.id, source))
      .run()
      .pipe(Effect.orDie)
    expect(yield* h.claim()).toBeUndefined()
    yield* h.turn(source, false)
    expect(yield* h.claim()).toBeUndefined()
    yield* h.turn(source)
    const next = (yield* h.claim())!
    expect(next.id).not.toBe(run.id)
    yield* h.tidy.finish(next.id, "completed")
    yield* h.database.db.delete(SessionTable).where(eq(SessionTable.id, source)).run().pipe(Effect.orDie)
    expect(yield* h.claim()).toBeUndefined()
    expect(yield* h.database.db.select().from(MemoryAutomaticSourceTable).all().pipe(Effect.orDie)).toHaveLength(1)
  }),
)

it.effect("foreign global directories and children cannot supply automatic work", () =>
  Effect.gen(function* () {
    const h = yield* host
    yield* h.automatic.confirm(h.place, confirmation)
    const foreign = yield* h.create(undefined, "/foreign")
    yield* h.turn(foreign)
    const child = yield* h.create()
    yield* h.turn(child)
    yield* h.database.db
      .update(SessionTable)
      .set({ parent_id: foreign })
      .where(eq(SessionTable.id, child))
      .run()
      .pipe(Effect.orDie)
    expect(yield* h.claim()).toBeUndefined()
    expect(
      (yield* h.automatic
        .claim(
          { ...h.place, scope: h.place.scope, project: ProjectV2.ID.make("changed") },
          confirmation.requestID,
          Effect.succeed(true),
          h.prepare,
        )
        .pipe(Effect.flip)).reason,
    ).toBe("unauthorized")
  }),
)

it.effect("busy and an activity change during selection leave no attempted version", () =>
  Effect.gen(function* () {
    const h = yield* host
    yield* h.automatic.confirm(h.place, confirmation)
    yield* h.turn(yield* h.create())
    expect(yield* h.claim(confirmation.requestID, Effect.succeed(false))).toBeUndefined()
    const state = { checks: 0 }
    expect(
      yield* h.claim(
        confirmation.requestID,
        Effect.sync(() => ++state.checks === 1),
      ),
    ).toBeUndefined()
    expect(yield* h.database.db.select().from(MemoryAutomaticSourceTable).all().pipe(Effect.orDie)).toEqual([])
    expect((yield* h.claim())?.state).toBe("active")
  }),
)

for (const state of ["active", "failed", "cancelled"] as const)
  it.effect(`automatic ${state} runs are not restarted; reconfirmation preserves attempted content`, () =>
    Effect.gen(function* () {
      const h = yield* host
      yield* h.automatic.confirm(h.place, confirmation)
      const source = yield* h.create()
      yield* h.turn(source)
      const run = (yield* h.claim())!
      if (state !== "active") yield* h.tidy.finish(run.id, state)
      expect(yield* h.claim()).toBeUndefined()
      const replacement = yield* h.automatic.confirm(h.place, {
        ...confirmation,
        expected: confirmation.requestID,
        requestID: "replacement",
      })
      expect(replacement.revokedRun).toBe(run.id)
      if (state === "active") {
        expect(
          (yield* h.tidy.authorize({ sessionID: run.session_id, scope: run.scope, enabled: true }).pipe(Effect.flip))
            .reason,
        ).toBe("unauthorized")
        yield* h.tidy.finish(run.id, "cancelled")
      }
      expect(yield* h.claim("replacement")).toBeUndefined()
      yield* h.turn(source)
      expect((yield* h.claim("replacement"))?.id).not.toBe(run.id)
    }),
  )

it.effect("disable revokes tool and physical-request authority before host interruption", () =>
  Effect.gen(function* () {
    const h = yield* host
    yield* h.automatic.confirm(h.place, confirmation)
    yield* h.turn(yield* h.create())
    const run = (yield* h.claim())!
    expect((yield* h.tidy.authorize({ sessionID: run.session_id, scope: run.scope, enabled: true })).id).toBe(run.id)
    expect((yield* h.automatic.disable(h.place.directory, confirmation.requestID)).revokedRun).toBe(run.id)
    expect(
      (yield* h.tidy.authorize({ sessionID: run.session_id, scope: run.scope, enabled: true }).pipe(Effect.flip))
        .reason,
    ).toBe("unauthorized")
    expect((yield* h.automatic.confirm(h.place, confirmation)).preference.enabled).toBe(false)
  }),
)

it.effect("failed durable admission rolls back source marks and can be explicitly attempted again", () =>
  Effect.gen(function* () {
    const h = yield* host
    yield* h.automatic.confirm(h.place, confirmation)
    yield* h.turn(yield* h.create())
    const result = yield* h.automatic
      .claim(h.place, confirmation.requestID, Effect.succeed(true), () =>
        Effect.fail(new MemoryTidyStore.Rejected({ reason: "limit" })),
      )
      .pipe(Effect.flip)
    expect(result.reason).toBe("limit")
    expect(yield* h.database.db.select().from(MemoryAutomaticSourceTable).all().pipe(Effect.orDie)).toEqual([])
    expect((yield* h.automatic.get(h.place.directory))?.current_run).toBeNull()
    expect((yield* h.claim())?.state).toBe("active")
  }),
)
