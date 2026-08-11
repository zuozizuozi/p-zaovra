import { describe, expect } from "bun:test"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { Work } from "@zaovra-ai/core/work"
import { WorkLease } from "@zaovra-ai/core/work/lease"
import { WorkGoalTable, WorkLeaseTable, WorkWorkerTable } from "@zaovra-ai/core/work/sql"
import { WorkWorker } from "@zaovra-ai/core/work/worker"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Database.node))
const goalID = Work.GoalID.make("goal_lease")

describe("WorkLease", () => {
  it.effect("serializes owners and advances a durable fencing token", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* insertGoal(db)
      const first = yield* WorkLease.Service.use((ownerA) =>
        ownerA.run(goalID, (claimA) =>
          WorkLease.Service.use((ownerB) => ownerB.run(goalID, (claimB) => Effect.succeed(claimB))).pipe(
            Effect.provide(WorkLease.makeLayer({ ownerID: "owner-b", durationMs: 1_000, heartbeatMs: 500 })),
            Effect.map((blocked) => ({ claimA, blocked })),
          ),
        ),
      ).pipe(Effect.provide(WorkLease.makeLayer({ ownerID: "owner-a", durationMs: 1_000, heartbeatMs: 500 })))

      expect(first).toMatchObject({ claimA: { ownerID: "owner-a", fence: 1 }, blocked: undefined })

      const second = yield* WorkLease.Service.use((ownerB) =>
        ownerB.run(goalID, (claim) => Effect.succeed(claim)),
      ).pipe(Effect.provide(WorkLease.makeLayer({ ownerID: "owner-b", durationMs: 1_000, heartbeatMs: 500 })))
      expect(second).toMatchObject({ ownerID: "owner-b", fence: 2 })
    }),
  )

  it.effect("rejects a stale owner after a newer fence takes over", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* insertGoal(db)
      const exit = yield* WorkLease.Service.use((lease) =>
        lease.run(goalID, (claim) =>
          db
            .update(WorkLeaseTable)
            .set({ owner_id: "new-owner", fence: claim.fence + 1, expires_at: 10_000, time_updated: 1 })
            .run()
            .pipe(Effect.orDie, Effect.andThen(lease.assert(claim))),
        ),
      ).pipe(
        Effect.provide(WorkLease.makeLayer({ ownerID: "old-owner", durationMs: 1_000, heartbeatMs: 500 })),
        Effect.exit,
      )

      expect(exit).toMatchObject({ _tag: "Failure" })
    }),
  )

  it.effect("does not admit new ownership while the Worker is draining or offline", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* insertGoal(db)
      yield* db
        .update(WorkWorkerTable)
        .set({ draining: true })
        .where(eq(WorkWorkerTable.id, WorkWorker.defaultID))
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* WorkLease.Service.use((lease) => lease.run(goalID, (claim) => Effect.succeed(claim))).pipe(
          Effect.provide(WorkLease.makeLayer({ ownerID: "draining-owner" })),
        ),
      ).toBeUndefined()

      yield* db
        .update(WorkWorkerTable)
        .set({ draining: false, expires_at: 0 })
        .where(eq(WorkWorkerTable.id, WorkWorker.defaultID))
        .run()
        .pipe(Effect.orDie)
      expect(
        yield* WorkLease.Service.use((lease) => lease.run(goalID, (claim) => Effect.succeed(claim))).pipe(
          Effect.provide(WorkLease.makeLayer({ ownerID: "offline-owner" })),
        ),
      ).toBeUndefined()
    }),
  )

  it.effect("lets the controller proxy a remote Worker but keeps shared Worker runtimes isolated", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const remoteID = Work.WorkerID.make("worker_remote_lease")
      yield* insertGoal(db)
      yield* db
        .insert(WorkWorkerTable)
        .values({
          id: remoteID,
          label: "Remote lease Worker",
          capabilities: ["execute"],
          workspace_roots: ["/project"],
          execution_mode: "remote",
          location_mappings: [{ controllerRoot: "/project", workerRoot: "/project" }],
          time_created: 1,
          time_heartbeat: 1,
          expires_at: 100_000,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(WorkGoalTable)
        .set({ worker_id: remoteID })
        .where(eq(WorkGoalTable.id, goalID))
        .run()
        .pipe(Effect.orDie)

      expect(
        yield* WorkLease.Service.use((lease) => lease.run(goalID, (claim) => Effect.succeed(claim))).pipe(
          Effect.provide(WorkLease.makeLayer({ ownerID: "shared-runtime", proxyRemote: false })),
        ),
      ).toBeUndefined()
      expect(
        yield* WorkLease.Service.use((lease) => lease.run(goalID, (claim) => Effect.succeed(claim))).pipe(
          Effect.provide(WorkLease.makeLayer({ ownerID: "controller-runtime" })),
        ),
      ).toMatchObject({ workerID: remoteID, ownerID: "controller-runtime", fence: 1 })
    }),
  )
})

function insertGoal(db: Database.Interface["db"]) {
  return Effect.gen(function* () {
    yield* db
      .insert(WorkWorkerTable)
      .values({
        id: WorkWorker.defaultID,
        label: "Lease test Worker",
        capabilities: ["execute"],
        workspace_roots: ["*"],
        time_created: 1,
        time_heartbeat: 1,
        expires_at: 100_000,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkGoalTable)
      .values({
        id: goalID,
        directory: AbsolutePath.make("/project"),
        objective: "Protect one Goal owner",
        acceptance_criteria: [],
        status: "active",
        usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
        revision: 0,
        time_created: 1,
        time_updated: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
}
