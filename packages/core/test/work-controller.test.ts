import { describe, expect } from "bun:test"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { Work } from "@zaovra-ai/core/work"
import { WorkController } from "@zaovra-ai/core/work/controller"
import { WorkLease } from "@zaovra-ai/core/work/lease"
import {
  WorkControllerDispatchTable,
  WorkControllerTable,
  WorkGoalTable,
  WorkLeaseTable,
  WorkWorkerTable,
} from "@zaovra-ai/core/work/sql"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Database.node))
const controllerA = Work.ControllerID.make("controller_cluster_a")
const controllerB = Work.ControllerID.make("controller_cluster_b")
const runtimeA = Work.ControllerRuntimeID.make("controller_runtime_cluster_a")
const runtimeB = Work.ControllerRuntimeID.make("controller_runtime_cluster_b")

describe("WorkController", () => {
  it.effect("lets only one controller lease a durable Goal signal", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const goalID = Work.GoalID.make("goal_controller_compete")
      yield* insertGoal(db, goalID)

      const result = yield* WorkController.Service.use((first) =>
        Effect.gen(function* () {
          yield* first.signal(goalID, "wake")
          const firstClaims = yield* first.claim({ goalID })
          const secondClaims = yield* WorkController.Service.use((second) => second.claim({ goalID })).pipe(
            Effect.provide(controllerLayer(controllerB, runtimeB)),
          )
          return { firstClaims, secondClaims }
        }),
      ).pipe(Effect.provide(controllerLayer(controllerA, runtimeA)))

      expect(result.firstClaims).toMatchObject([
        { goalID, controllerID: controllerA, runtimeID: runtimeA, revision: 1, fence: 1 },
      ])
      expect(result.secondClaims).toEqual([])
    }),
  )

  it.effect("routes a new signal to the active Goal lease owner", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const goalID = Work.GoalID.make("goal_controller_route")
      yield* insertGoal(db, goalID)
      yield* db
        .insert(WorkLeaseTable)
        .values({
          goal_id: goalID,
          controller_id: controllerA,
          controller_runtime_id: runtimeA,
          owner_id: "owner-a",
          worker_id: Work.WorkerID.make("worker_local"),
          fence: 1,
          expires_at: Date.now() + 60_000,
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)

      yield* WorkController.Service.use((controller) => controller.signal(goalID, "interrupt")).pipe(
        Effect.provide(controllerLayer(controllerB, runtimeB)),
      )
      const blocked = yield* WorkController.Service.use((controller) => controller.claim({ goalID })).pipe(
        Effect.provide(controllerLayer(controllerB, runtimeB)),
      )
      const routed = yield* WorkController.Service.use((controller) =>
        Effect.all([controller.claim({ goalID }), controller.interrupts]),
      ).pipe(Effect.provide(controllerLayer(controllerA, runtimeA)))

      expect(blocked).toEqual([])
      expect(routed[0]).toMatchObject([{ controllerID: controllerA, runtimeID: runtimeA, signal: "interrupt" }])
      expect(routed[1]).toEqual([goalID])
    }),
  )

  it.effect("fences a stale dispatch after controller failover", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const goalID = Work.GoalID.make("goal_controller_failover")
      yield* insertGoal(db, goalID)
      const stale = yield* WorkController.Service.use((controller) =>
        controller.signal(goalID, "wake").pipe(
          Effect.andThen(controller.claim({ goalID })),
          Effect.map((rows) => rows[0]),
        ),
      ).pipe(Effect.provide(controllerLayer(controllerA, runtimeA)))

      yield* db
        .update(WorkControllerDispatchTable)
        .set({ lease_expires_at: 0 })
        .where(eq(WorkControllerDispatchTable.goal_id, goalID))
        .run()
        .pipe(Effect.orDie)
      const current = yield* WorkController.Service.use((controller) => controller.claim({ goalID })).pipe(
        Effect.provide(controllerLayer(controllerB, runtimeB)),
      )
      const staleExit = yield* WorkController.Service.use((controller) => controller.run(stale, Effect.void)).pipe(
        Effect.provide(controllerLayer(controllerA, runtimeA)),
        Effect.exit,
      )

      expect(current).toMatchObject([{ controllerID: controllerB, runtimeID: runtimeB, fence: 2 }])
      expect(Exit.isFailure(staleExit)).toBe(true)
    }),
  )

  it.effect("does not lose a signal recorded while the prior revision settles", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const goalID = Work.GoalID.make("goal_controller_revision")
      yield* insertGoal(db, goalID)
      const result = yield* WorkController.Service.use((controller) =>
        Effect.gen(function* () {
          yield* controller.signal(goalID, "wake")
          const first = (yield* controller.claim({ goalID }))[0]
          yield* controller.signal(goalID, "interrupt")
          yield* controller.run(first, Effect.void)
          const second = (yield* controller.claim({ goalID }))[0]
          return { first, second, dispatch: (yield* controller.dispatches(goalID))[0] }
        }),
      ).pipe(Effect.provide(controllerLayer(controllerA, runtimeA)))

      expect(result.first).toMatchObject({ revision: 1, fence: 1, signal: "wake" })
      expect(result.second).toMatchObject({ revision: 2, fence: 2, signal: "interrupt" })
      expect(result.dispatch).toMatchObject({ revision: 2, processedRevision: 1, status: "leased" })
    }),
  )

  it.effect("stops assigning new signals while a controller drains", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const goalID = Work.GoalID.make("goal_controller_drain")
      yield* insertGoal(db, goalID)
      const result = yield* WorkController.Service.use((controller) =>
        Effect.gen(function* () {
          yield* controller.signal(goalID, "wake")
          expect(yield* controller.setDraining(true)).toMatchObject({ status: "draining" })
          return yield* controller.claim({ goalID })
        }),
      ).pipe(Effect.provide(controllerLayer(controllerA, runtimeA)))

      expect(result).toEqual([])
    }),
  )

  it.effect("rejects a second live runtime but permits takeover after expiry", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const second = Work.ControllerRuntimeID.make("controller_runtime_cluster_second")
      const collision = yield* WorkController.Service.use(() =>
        WorkController.Service.use((controller) => Effect.succeed(controller.identity)).pipe(
          Effect.provide(controllerLayer(controllerA, second)),
          Effect.exit,
        ),
      ).pipe(Effect.provide(controllerLayer(controllerA, runtimeA)))
      expect(Exit.isFailure(collision)).toBe(true)

      yield* db
        .update(WorkControllerTable)
        .set({ expires_at: 0 })
        .where(eq(WorkControllerTable.id, controllerA))
        .run()
        .pipe(Effect.orDie)
      const takeover = yield* WorkController.Service.use((controller) => Effect.succeed(controller.identity)).pipe(
        Effect.provide(controllerLayer(controllerA, second)),
      )
      expect(takeover).toMatchObject({ id: controllerA, runtimeID: second, status: "online" })
    }),
  )

  it.effect("prevents an expired Controller runtime from renewing its Goal lease after takeover", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const goalID = Work.GoalID.make("goal_controller_runtime_fence")
      const replacement = Work.ControllerRuntimeID.make("controller_runtime_cluster_replacement")
      yield* insertGoal(db, goalID)
      yield* WorkController.Service.use(() => Effect.void).pipe(Effect.provide(controllerLayer(controllerA, runtimeA)))
      const stale = yield* WorkLease.Service.use((lease) => lease.run(goalID, (claim) => Effect.succeed(claim))).pipe(
        Effect.provide(
          WorkLease.makeLayer({
            controllerID: controllerA,
            controllerRuntimeID: runtimeA,
            ownerID: "stale-owner",
            requireController: true,
          }),
        ),
      )
      if (!stale) return yield* Effect.die("Initial Controller failed to acquire the Goal lease")
      yield* db
        .update(WorkLeaseTable)
        .set({ expires_at: Date.now() + 60_000 })
        .where(eq(WorkLeaseTable.goal_id, goalID))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(WorkControllerTable)
        .set({ expires_at: 0 })
        .where(eq(WorkControllerTable.id, controllerA))
        .run()
        .pipe(Effect.orDie)
      yield* WorkController.Service.use(() => Effect.void).pipe(
        Effect.provide(controllerLayer(controllerA, replacement)),
      )

      const staleExit = yield* WorkLease.Service.use((lease) => lease.assert(stale)).pipe(
        Effect.provide(
          WorkLease.makeLayer({
            controllerID: controllerA,
            controllerRuntimeID: runtimeA,
            ownerID: "stale-owner",
            requireController: true,
          }),
        ),
        Effect.exit,
      )
      yield* db
        .update(WorkLeaseTable)
        .set({ expires_at: 0 })
        .where(eq(WorkLeaseTable.goal_id, goalID))
        .run()
        .pipe(Effect.orDie)
      const current = yield* WorkLease.Service.use((lease) => lease.run(goalID, (claim) => Effect.succeed(claim))).pipe(
        Effect.provide(
          WorkLease.makeLayer({
            controllerID: controllerA,
            controllerRuntimeID: replacement,
            ownerID: "replacement-owner",
            requireController: true,
          }),
        ),
      )

      expect(Exit.isFailure(staleExit)).toBe(true)
      expect(current).toMatchObject({
        controllerID: controllerA,
        controllerRuntimeID: replacement,
        ownerID: "replacement-owner",
        fence: stale.fence + 1,
      })
      return undefined
    }),
  )
})

function controllerLayer(controllerID: Work.ControllerID, runtimeID: Work.ControllerRuntimeID) {
  return WorkController.makeLayer({
    controllerID,
    runtimeID,
    durationMs: 60_000,
    heartbeatMs: 30_000,
    dispatchDurationMs: 60_000,
    dispatchHeartbeatMs: 30_000,
  })
}

function insertGoal(db: Database.Interface["db"], goalID: Work.GoalID) {
  return Effect.gen(function* () {
    yield* db
      .insert(WorkWorkerTable)
      .values({
        id: Work.WorkerID.make("worker_local"),
        label: "Local Worker",
        capabilities: ["execute"],
        workspace_roots: ["*"],
        time_created: 1,
        time_heartbeat: 1,
        expires_at: Date.now() + 60_000,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkGoalTable)
      .values({
        id: goalID,
        directory: AbsolutePath.make("/project"),
        objective: "Coordinate controllers",
        acceptance_criteria: [],
        status: "active",
        usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
        revision: 0,
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie)
  })
}
