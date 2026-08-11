export * as WorkLease from "./lease"

import { Work } from "@zaovra-ai/schema/work"
import { and, eq, gt } from "drizzle-orm"
import { Clock, Context, DateTime, Effect, Layer, Schedule, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { NonNegativeInt } from "../schema"
import { WorkControllerTable, WorkGoalTable, WorkLeaseTable, WorkWorkerTable } from "./sql"
import { WorkWorker } from "./worker"
import { WorkController } from "./controller"

const DEFAULT_DURATION_MS = 15_000
const DEFAULT_HEARTBEAT_MS = 5_000

export type Claim = {
  readonly goalID: Work.GoalID
  readonly controllerID: Work.ControllerID
  readonly controllerRuntimeID: Work.ControllerRuntimeID
  readonly ownerID: string
  readonly workerID: Work.WorkerID
  readonly fence: number
}

export class LostError extends Schema.TaggedErrorClass<LostError>()("WorkLease.Lost", {
  goalID: Work.GoalID,
  ownerID: Schema.String,
  fence: NonNegativeInt,
}) {}

export interface Interface {
  readonly run: <A, E, R>(
    goalID: Work.GoalID,
    use: (claim: Claim) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A | undefined, E | LostError, R>
  readonly assert: (claim: Claim) => Effect.Effect<void, LostError>
  readonly inspect: (goalID: Work.GoalID) => Effect.Effect<Work.WorkerLeaseInfo | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkLease") {}

export const layer = makeLayer({ requireController: true })

export function makeLayer(options?: {
  readonly ownerID?: string
  readonly workerID?: Work.WorkerID
  readonly durationMs?: number
  readonly heartbeatMs?: number
  readonly proxyRemote?: boolean
  readonly controllerID?: Work.ControllerID
  readonly controllerRuntimeID?: Work.ControllerRuntimeID
  readonly requireController?: boolean
}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const workerID = options?.workerID ?? WorkWorker.defaultID
      const controllerID = options?.controllerID ?? WorkController.defaultControllerID
      const controllerRuntimeID = options?.controllerRuntimeID ?? WorkController.defaultRuntimeID
      const ownerID = options?.ownerID ?? `${workerID}/runtime/${crypto.randomUUID()}`
      const durationMs = options?.durationMs ?? DEFAULT_DURATION_MS
      const heartbeatMs = options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
      const locks = KeyedMutex.makeUnsafe<Work.GoalID>()

      const lost = (claim: Claim) => new LostError(claim)

      const acquire = Effect.fn("WorkLease.acquire")(function* (goalID: Work.GoalID) {
        const now = yield* Clock.currentTimeMillis
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const current = yield* tx
                  .select()
                  .from(WorkLeaseTable)
                  .where(eq(WorkLeaseTable.goal_id, goalID))
                  .get()
                  .pipe(Effect.orDie)
                const goal = yield* tx
                  .select({ workerID: WorkGoalTable.worker_id })
                  .from(WorkGoalTable)
                  .where(eq(WorkGoalTable.id, goalID))
                  .get()
                  .pipe(Effect.orDie)
                if (!goal) return undefined
                if (options?.requireController) {
                  const controller = yield* tx
                    .select({
                      runtimeID: WorkControllerTable.runtime_id,
                      draining: WorkControllerTable.draining,
                      expiresAt: WorkControllerTable.expires_at,
                    })
                    .from(WorkControllerTable)
                    .where(eq(WorkControllerTable.id, controllerID))
                    .get()
                    .pipe(Effect.orDie)
                  if (
                    !controller ||
                    controller.runtimeID !== controllerRuntimeID ||
                    controller.draining ||
                    controller.expiresAt <= now
                  )
                    return undefined
                }
                const claimWorkerID = goal.workerID ?? workerID
                const worker = yield* tx
                  .select({
                    capabilities: WorkWorkerTable.capabilities,
                    draining: WorkWorkerTable.draining,
                    expiresAt: WorkWorkerTable.expires_at,
                    mode: WorkWorkerTable.execution_mode,
                  })
                  .from(WorkWorkerTable)
                  .where(eq(WorkWorkerTable.id, claimWorkerID))
                  .get()
                  .pipe(Effect.orDie)
                if (!worker || worker.expiresAt <= now || worker.draining || !worker.capabilities.includes("execute"))
                  return undefined
                const proxy = claimWorkerID !== workerID
                if (proxy && (options?.proxyRemote === false || worker.mode !== "remote")) return undefined
                if (!proxy && options?.proxyRemote === false && worker.mode === "remote") return undefined
                if (current && current.expires_at > now) return undefined
                const claim = {
                  goalID,
                  controllerID,
                  controllerRuntimeID,
                  ownerID,
                  workerID: claimWorkerID,
                  fence: (current?.fence ?? 0) + 1,
                } satisfies Claim
                if (!current) {
                  yield* tx
                    .insert(WorkLeaseTable)
                    .values({
                      goal_id: goalID,
                      controller_id: controllerID,
                      controller_runtime_id: controllerRuntimeID,
                      owner_id: ownerID,
                      worker_id: claimWorkerID,
                      fence: claim.fence,
                      expires_at: now + durationMs,
                      time_updated: now,
                    })
                    .run()
                    .pipe(Effect.orDie)
                  return claim
                }
                yield* tx
                  .update(WorkLeaseTable)
                  .set({
                    controller_id: controllerID,
                    controller_runtime_id: controllerRuntimeID,
                    owner_id: ownerID,
                    worker_id: claimWorkerID,
                    fence: claim.fence,
                    expires_at: now + durationMs,
                    time_updated: now,
                  })
                  .where(eq(WorkLeaseTable.goal_id, goalID))
                  .run()
                  .pipe(Effect.orDie)
                return claim
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      })

      const assert = Effect.fn("WorkLease.assert")(function* (claim: Claim) {
        const now = yield* Clock.currentTimeMillis
        if (options?.requireController) {
          const controller = yield* db
            .select({ runtimeID: WorkControllerTable.runtime_id, expiresAt: WorkControllerTable.expires_at })
            .from(WorkControllerTable)
            .where(eq(WorkControllerTable.id, claim.controllerID))
            .get()
            .pipe(Effect.orDie)
          if (!controller || controller.runtimeID !== claim.controllerRuntimeID || controller.expiresAt <= now)
            return yield* lost(claim)
        }
        const current = yield* db
          .select({ goalID: WorkLeaseTable.goal_id })
          .from(WorkLeaseTable)
          .where(
            and(
              eq(WorkLeaseTable.goal_id, claim.goalID),
              eq(WorkLeaseTable.controller_id, claim.controllerID),
              eq(WorkLeaseTable.controller_runtime_id, claim.controllerRuntimeID),
              eq(WorkLeaseTable.owner_id, claim.ownerID),
              eq(WorkLeaseTable.worker_id, claim.workerID),
              eq(WorkLeaseTable.fence, claim.fence),
              gt(WorkLeaseTable.expires_at, now),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!current) yield* lost(claim)
        return undefined
      })

      const renew = Effect.fn("WorkLease.renew")(function* (claim: Claim) {
        const now = yield* Clock.currentTimeMillis
        const current = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                if (options?.requireController) {
                  const controller = yield* tx
                    .select({ runtimeID: WorkControllerTable.runtime_id, expiresAt: WorkControllerTable.expires_at })
                    .from(WorkControllerTable)
                    .where(eq(WorkControllerTable.id, claim.controllerID))
                    .get()
                    .pipe(Effect.orDie)
                  if (!controller || controller.runtimeID !== claim.controllerRuntimeID || controller.expiresAt <= now)
                    return undefined
                }
                return yield* tx
                  .update(WorkLeaseTable)
                  .set({ expires_at: now + durationMs, time_updated: now })
                  .where(
                    and(
                      eq(WorkLeaseTable.goal_id, claim.goalID),
                      eq(WorkLeaseTable.controller_id, claim.controllerID),
                      eq(WorkLeaseTable.controller_runtime_id, claim.controllerRuntimeID),
                      eq(WorkLeaseTable.owner_id, claim.ownerID),
                      eq(WorkLeaseTable.worker_id, claim.workerID),
                      eq(WorkLeaseTable.fence, claim.fence),
                      gt(WorkLeaseTable.expires_at, now),
                    ),
                  )
                  .returning({ goalID: WorkLeaseTable.goal_id })
                  .get()
                  .pipe(Effect.orDie)
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        if (!current) yield* lost(claim)
      })

      const release = Effect.fn("WorkLease.release")(function* (claim: Claim) {
        const now = yield* Clock.currentTimeMillis
        yield* db
          .update(WorkLeaseTable)
          .set({ expires_at: now, time_updated: now })
          .where(
            and(
              eq(WorkLeaseTable.goal_id, claim.goalID),
              eq(WorkLeaseTable.controller_id, claim.controllerID),
              eq(WorkLeaseTable.controller_runtime_id, claim.controllerRuntimeID),
              eq(WorkLeaseTable.owner_id, claim.ownerID),
              eq(WorkLeaseTable.worker_id, claim.workerID),
              eq(WorkLeaseTable.fence, claim.fence),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      })

      const run: Interface["run"] = (goalID, use) =>
        locks.withLock(goalID)(
          Effect.acquireUseRelease(
            acquire(goalID),
            (claim) => {
              if (!claim) return Effect.succeed(undefined)
              const heartbeat = renew(claim).pipe(
                Effect.repeat(Schedule.spaced(heartbeatMs)),
                Effect.andThen(Effect.never),
              )
              return use(claim).pipe(Effect.raceFirst(heartbeat))
            },
            (claim) => (claim ? release(claim) : Effect.void),
          ),
        )

      return Service.of({
        run,
        assert,
        inspect: Effect.fn("WorkLease.inspect")(function* (goalID) {
          const row = yield* db
            .select()
            .from(WorkLeaseTable)
            .where(eq(WorkLeaseTable.goal_id, goalID))
            .get()
            .pipe(Effect.orDie)
          if (!row) return undefined
          const now = yield* Clock.currentTimeMillis
          return Work.WorkerLeaseInfo.make({
            goalID: row.goal_id,
            workerID: row.worker_id,
            controllerID: row.controller_id ?? undefined,
            controllerRuntimeID: row.controller_runtime_id ?? undefined,
            ownerID: row.owner_id,
            fence: row.fence,
            status: row.expires_at > now ? "active" : "expired",
            expiresAt: DateTime.makeUnsafe(row.expires_at),
            updatedAt: DateTime.makeUnsafe(row.time_updated),
          })
        }),
      })
    }),
  )
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, WorkController.node, WorkWorker.node],
})
