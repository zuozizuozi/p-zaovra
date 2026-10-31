import { expect } from "bun:test"
import { Effect, Layer, DateTime } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionBudget } from "../src/session/budget"
import { SessionTable } from "../src/session/sql"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { SessionEvent } from "../src/session/event"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { Work } from "@zaovra-ai/schema/work"
import { WorkGoalTable, WorkTaskTable, WorkAttemptTable } from "../src/work/sql"
import { tmpdir } from "./fixture/tmpdir"
import { location } from "./fixture/location"
import { it } from "./lib/effect"

const withRuntime = <A, E, R>(body: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      body(tmp.path).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([SessionV2.node, Database.node, EventV2.node]), [
            [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
            [Global.node, Global.layerWith({ data: tmp.path })],
            [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
            [SessionExecution.node, SessionExecution.noopLayer],
          ]),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

for (const source of [
  "interactive",
  "headless-root",
  "ordinary-fork",
  "autonomous-root",
  "autonomous-child",
  "legacy",
] as const)
  it.live(
    `469 budget source/config/override matrix: ${source}`,
    () =>
      withRuntime((directory) =>
        Effect.gen(function* () {
          const sessions = yield* SessionV2.Service
          const database = yield* Database.Service
          const parent = yield* sessions.create({
            location: { directory: AbsolutePath.make(directory) },
            budgetMode: "autonomous",
          })
          for (const configured of [undefined, 42, null])
            for (const override of [undefined, 7, null, "duration-only"] as const) {
              const session = yield* sessions.create({
                location: parent.location,
                parentID: source === "ordinary-fork" || source === "autonomous-child" ? parent.id : undefined,
                budgetMode: source.startsWith("autonomous") ? "autonomous" : undefined,
              })
              if (source === "legacy")
                yield* database.db
                  .update(SessionTable)
                  .set({ metadata: null })
                  .where(eq(SessionTable.id, session.id))
                  .run()
                  .pipe(Effect.orDie)
              const config = Config.Service.of({
                entries: () =>
                  Effect.succeed([
                    new Config.Document({
                      type: "document",
                      info: new Config.Info({ session_token_budget: configured }),
                    }),
                  ]),
              })
              if (override !== undefined)
                yield* sessions.update({
                  sessionID: session.id,
                  budget: override === "duration-only" ? { durationMs: 1234 } : { tokens: override },
                })
              const defaultLimit = source.startsWith("autonomous") || source === "legacy" ? 30_000_000 : undefined
              const expected =
                override === null
                  ? undefined
                  : typeof override === "number"
                    ? override
                    : configured === null
                      ? undefined
                      : (configured ?? defaultLimit)
              expect(yield* SessionBudget.read(database.db, config, session.id)).toEqual({
                limit: expected,
                duration: override === "duration-only" ? 1234 : 43_200_000,
              })
              // A fresh reader has no process-local mode/override cache to carry over.
              expect(yield* SessionBudget.read(database.db, config, session.id)).toEqual({
                limit: expected,
                duration: override === "duration-only" ? 1234 : 43_200_000,
              })
            }
        }),
      ),
    30000,
  )

it.live("469 independent budget axes preserve omissions and legacy history", () =>
  withRuntime((directory) =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const config = Config.Service.of({ entries: () => Effect.succeed([]) })
      const session = yield* sessions.create({
        location: { directory: AbsolutePath.make(directory) },
        budgetMode: "autonomous",
      })
      yield* sessions.update({ sessionID: session.id, budget: { tokens: 100, durationMs: 5000 } })
      yield* sessions.update({ sessionID: session.id, budget: { tokens: null } })
      yield* sessions.update({ sessionID: session.id, title: "No budget update" })
      yield* sessions.update({ sessionID: session.id, budget: {} })
      expect(yield* SessionBudget.read(database.db, config, session.id)).toEqual({ limit: undefined, duration: 5000 })
      yield* sessions.update({ sessionID: session.id, budget: { tokens: 300 } })
      expect(yield* SessionBudget.read(database.db, config, session.id)).toEqual({ limit: 300, duration: 5000 })
      yield* sessions.update({ sessionID: session.id, budget: { durationMs: null } })
      expect(yield* SessionBudget.read(database.db, config, session.id)).toEqual({ limit: 300, duration: undefined })
      // Unmarked historical updates retain their original replacement semantics.
      yield* events.publish(SessionEvent.Updated, { sessionID: session.id, timestamp: yield* DateTime.now, budget: {} })
      expect(yield* SessionBudget.read(database.db, config, session.id)).toEqual({
        limit: undefined,
        duration: undefined,
      })
      expect(yield* SessionBudget.read(database.db, config, SessionV2.ID.make("ses_not_projected"))).toEqual({
        limit: 30_000_000,
        duration: 43_200_000,
      })
    }),
  ),
)

it.live("469 WorkAttempt identity remains autonomous in every lifecycle status without parentage", () =>
  withRuntime((directory) =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      const config = Config.Service.of({ entries: () => Effect.succeed([]) })
      const goalID = Work.GoalID.create()
      const taskID = Work.TaskID.create()
      yield* database.db
        .insert(WorkGoalTable)
        .values({
          id: goalID,
          directory: AbsolutePath.make(directory),
          objective: "fixed",
          acceptance_criteria: [],
          status: "draft",
          usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
          revision: 0,
          time_created: 0,
          time_updated: 0,
        })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(WorkTaskTable)
        .values({
          id: taskID,
          goal_id: goalID,
          title: "fixed",
          instructions: "fixed",
          depends_on: [],
          role: "builder",
          status: "pending",
          criteria: [],
          attempt_count: 0,
          revision: 0,
          time_created: 0,
          time_updated: 0,
        })
        .run()
        .pipe(Effect.orDie)
      for (const kind of ["review", "plan", "execute"] as const)
        for (const status of [
          "admitted",
          "running",
          "succeeded",
          "failed",
          "interrupted",
          "unknown",
          "cancelled",
        ] as const) {
          const session = yield* sessions.create({ location: { directory: AbsolutePath.make(directory) } })
          yield* database.db
            .insert(WorkAttemptTable)
            .values({
              id: Work.AttemptID.create(),
              goal_id: goalID,
              task_id: taskID,
              kind,
              number:
                ["review", "plan", "execute"].indexOf(kind) * 7 +
                ["admitted", "running", "succeeded", "failed", "interrupted", "unknown", "cancelled"].indexOf(status) +
                1,
              session_id: session.id,
              status,
              input_revision: 0,
              time_created: 0,
            })
            .run()
            .pipe(Effect.orDie)
          expect(yield* SessionBudget.read(database.db, config, session.id)).toEqual({
            limit: 30_000_000,
            duration: 43_200_000,
          })
        }
    }),
  ),
)

it.live("469 parent/child budget adjustments remain independent across Stop and renewal", () =>
  withRuntime((directory) =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const database = yield* Database.Service
      const config = Config.Service.of({ entries: () => Effect.succeed([]) })
      const parent = yield* sessions.create({
        location: { directory: AbsolutePath.make(directory) },
        budgetMode: "autonomous",
      })
      const child = yield* sessions.create({ location: parent.location, parentID: parent.id })
      yield* Effect.all(
        [
          sessions.update({ sessionID: parent.id, budget: { tokens: 10, durationMs: 5000 } }),
          sessions.update({ sessionID: child.id, budget: { durationMs: 7000 } }),
        ],
        { concurrency: "unbounded" },
      )
      yield* sessions.interrupt(parent.id)
      yield* sessions.update({ sessionID: parent.id, budget: { tokens: null } })
      yield* sessions.update({ sessionID: child.id, title: "Ordinary fork continues independently" })
      expect(yield* SessionBudget.read(database.db, config, parent.id)).toEqual({ limit: undefined, duration: 5000 })
      expect(yield* SessionBudget.read(database.db, config, child.id)).toEqual({ limit: undefined, duration: 7000 })
      yield* sessions.update({ sessionID: parent.id, budget: { tokens: 123 } })
      expect(yield* SessionBudget.read(database.db, config, parent.id)).toEqual({ limit: 123, duration: 5000 })
      expect(yield* SessionBudget.read(database.db, config, child.id)).toEqual({ limit: undefined, duration: 7000 })
    }),
  ),
)
