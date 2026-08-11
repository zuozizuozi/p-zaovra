export * as WorkController from "./controller"

import { Work } from "@zaovra-ai/schema/work"
import { and, asc, eq, gt } from "drizzle-orm"
import { hostname } from "node:os"
import { Clock, Context, DateTime, Effect, Exit, Layer, Schedule, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { NonNegativeInt } from "../schema"
import { WorkControllerDispatchTable, WorkControllerTable, WorkLeaseTable } from "./sql"

const DEFAULT_DURATION_MS = 15_000
const DEFAULT_HEARTBEAT_MS = 5_000
const DEFAULT_DISPATCH_DURATION_MS = 20_000
const DEFAULT_DISPATCH_HEARTBEAT_MS = 5_000

export type Claim = {
  readonly goalID: Work.GoalID
  readonly controllerID: Work.ControllerID
  readonly runtimeID: Work.ControllerRuntimeID
  readonly revision: number
  readonly fence: number
  readonly signal: Work.ControllerDispatchSignal
}

export class CollisionError extends Schema.TaggedErrorClass<CollisionError>()("WorkController.Collision", {
  controllerID: Work.ControllerID,
  runtimeID: Work.ControllerRuntimeID,
}) {}

export class LostError extends Schema.TaggedErrorClass<LostError>()("WorkController.Lost", {
  goalID: Work.GoalID,
  controllerID: Work.ControllerID,
  runtimeID: Work.ControllerRuntimeID,
  revision: NonNegativeInt,
  fence: NonNegativeInt,
}) {}

export interface Interface {
  readonly identity: Work.ControllerInfo
  readonly all: Effect.Effect<ReadonlyArray<Work.ControllerInfo>>
  readonly dispatches: (goalID?: Work.GoalID) => Effect.Effect<ReadonlyArray<Work.ControllerDispatchInfo>>
  readonly signal: (goalID: Work.GoalID, signal: Work.ControllerDispatchSignal) => Effect.Effect<void>
  readonly claim: (options?: {
    readonly goalID?: Work.GoalID
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<Claim>>
  readonly run: <A, E, R>(claim: Claim, use: Effect.Effect<A, E, R>) => Effect.Effect<A, E | LostError, R>
  readonly interrupts: Effect.Effect<ReadonlyArray<Work.GoalID>>
  readonly activeGoals: Effect.Effect<ReadonlySet<Work.GoalID>>
  readonly setDraining: (draining: boolean) => Effect.Effect<Work.ControllerInfo>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkController") {}

export const layer = makeLayer()

const configuredControllerID = process.env.ZAOVRA_CONTROLLER_ID?.trim()
export const defaultControllerID = Work.ControllerID.make(
  configuredControllerID?.startsWith("controller_")
    ? configuredControllerID
    : `controller_${new Bun.CryptoHasher("sha256").update(`${hostname()}:${process.pid}`).digest("hex").slice(0, 20)}`,
)
export const defaultRuntimeID = Work.ControllerRuntimeID.create()

export function makeLayer(options?: {
  readonly controllerID?: Work.ControllerID
  readonly runtimeID?: Work.ControllerRuntimeID
  readonly label?: string
  readonly endpoint?: string
  readonly durationMs?: number
  readonly heartbeatMs?: number
  readonly dispatchDurationMs?: number
  readonly dispatchHeartbeatMs?: number
}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const controllerID = options?.controllerID ?? defaultControllerID
      const runtimeID = options?.runtimeID ?? defaultRuntimeID
      const durationMs = options?.durationMs ?? DEFAULT_DURATION_MS
      const heartbeatMs = options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
      const dispatchDurationMs = options?.dispatchDurationMs ?? DEFAULT_DISPATCH_DURATION_MS
      const dispatchHeartbeatMs = options?.dispatchHeartbeatMs ?? DEFAULT_DISPATCH_HEARTBEAT_MS

      const heartbeat = Effect.fn("WorkController.heartbeat")(function* () {
        const now = yield* Clock.currentTimeMillis
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const current = yield* tx
                  .select()
                  .from(WorkControllerTable)
                  .where(eq(WorkControllerTable.id, controllerID))
                  .get()
                  .pipe(Effect.orDie)
                if (current && current.runtime_id !== runtimeID && current.expires_at > now)
                  return yield* new CollisionError({ controllerID, runtimeID })
                if (!current) {
                  yield* tx
                    .insert(WorkControllerTable)
                    .values({
                      id: controllerID,
                      runtime_id: runtimeID,
                      label: clean(
                        options?.label ?? process.env.ZAOVRA_CONTROLLER_LABEL ?? `${hostname()} ${process.pid}`,
                        200,
                      ),
                      endpoint: optionalText(options?.endpoint ?? process.env.ZAOVRA_CONTROLLER_ENDPOINT, 2_000),
                      time_started: now,
                      time_heartbeat: now,
                      expires_at: now + durationMs,
                    })
                    .run()
                    .pipe(Effect.orDie)
                } else {
                  yield* tx
                    .update(WorkControllerTable)
                    .set({
                      runtime_id: runtimeID,
                      label: clean(options?.label ?? process.env.ZAOVRA_CONTROLLER_LABEL ?? current.label, 200),
                      endpoint:
                        optionalText(options?.endpoint ?? process.env.ZAOVRA_CONTROLLER_ENDPOINT, 2_000) ??
                        current.endpoint,
                      draining: current.runtime_id === runtimeID ? current.draining : false,
                      time_started: current.runtime_id === runtimeID ? current.time_started : now,
                      time_heartbeat: now,
                      expires_at: now + durationMs,
                    })
                    .where(eq(WorkControllerTable.id, controllerID))
                    .run()
                    .pipe(Effect.orDie)
                }
                const stored = yield* tx
                  .select()
                  .from(WorkControllerTable)
                  .where(eq(WorkControllerTable.id, controllerID))
                  .get()
                  .pipe(Effect.orDie)
                return info(stored!, now)
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      })

      const identity = yield* heartbeat()
      yield* heartbeat().pipe(
        Effect.catchCause((cause) => Effect.logError("Work controller heartbeat failed; retrying", { cause })),
        Effect.repeat(Schedule.spaced(heartbeatMs)),
        Effect.forkScoped,
      )

      const lost = (claim: Claim) => new LostError(claim)

      const renew = Effect.fn("WorkController.renewDispatch")(function* (claim: Claim) {
        const now = yield* Clock.currentTimeMillis
        const row = yield* db
          .update(WorkControllerDispatchTable)
          .set({ lease_expires_at: now + dispatchDurationMs, time_updated: now })
          .where(
            and(
              eq(WorkControllerDispatchTable.goal_id, claim.goalID),
              eq(WorkControllerDispatchTable.controller_id, claim.controllerID),
              eq(WorkControllerDispatchTable.runtime_id, claim.runtimeID),
              eq(WorkControllerDispatchTable.fence, claim.fence),
              gt(WorkControllerDispatchTable.lease_expires_at, now),
            ),
          )
          .returning({ goalID: WorkControllerDispatchTable.goal_id })
          .get()
          .pipe(Effect.orDie)
        if (!row) yield* lost(claim)
      })

      const complete = Effect.fn("WorkController.completeDispatch")(function* (claim: Claim) {
        const now = yield* Clock.currentTimeMillis
        const row = yield* db
          .update(WorkControllerDispatchTable)
          .set({
            processed_revision: claim.revision,
            controller_id: null,
            runtime_id: null,
            lease_expires_at: null,
            time_updated: now,
          })
          .where(
            and(
              eq(WorkControllerDispatchTable.goal_id, claim.goalID),
              eq(WorkControllerDispatchTable.controller_id, claim.controllerID),
              eq(WorkControllerDispatchTable.runtime_id, claim.runtimeID),
              eq(WorkControllerDispatchTable.fence, claim.fence),
              gt(WorkControllerDispatchTable.lease_expires_at, now),
            ),
          )
          .returning({ goalID: WorkControllerDispatchTable.goal_id })
          .get()
          .pipe(Effect.orDie)
        if (!row) yield* lost(claim)
      })

      const release = Effect.fn("WorkController.releaseDispatch")(function* (claim: Claim) {
        yield* db
          .update(WorkControllerDispatchTable)
          .set({ lease_expires_at: yield* Clock.currentTimeMillis, time_updated: yield* Clock.currentTimeMillis })
          .where(
            and(
              eq(WorkControllerDispatchTable.goal_id, claim.goalID),
              eq(WorkControllerDispatchTable.controller_id, claim.controllerID),
              eq(WorkControllerDispatchTable.runtime_id, claim.runtimeID),
              eq(WorkControllerDispatchTable.fence, claim.fence),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      })

      return Service.of({
        identity,
        all: Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          return (yield* db
            .select()
            .from(WorkControllerTable)
            .orderBy(asc(WorkControllerTable.time_started), asc(WorkControllerTable.id))
            .all()
            .pipe(Effect.orDie)).map((row) => info(row, now))
        }),
        dispatches: Effect.fn("WorkController.dispatches")(function* (goalID) {
          const query = db.select().from(WorkControllerDispatchTable)
          const rows = yield* (
            goalID
              ? query.where(eq(WorkControllerDispatchTable.goal_id, goalID)).all()
              : query.orderBy(asc(WorkControllerDispatchTable.time_requested)).all()
          ).pipe(Effect.orDie)
          const now = yield* Clock.currentTimeMillis
          return rows.map((row) => dispatchInfo(row, now))
        }),
        signal: Effect.fn("WorkController.signal")(function* (goalID, signal) {
          const now = yield* Clock.currentTimeMillis
          yield* db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  const current = yield* tx
                    .select()
                    .from(WorkControllerDispatchTable)
                    .where(eq(WorkControllerDispatchTable.goal_id, goalID))
                    .get()
                    .pipe(Effect.orDie)
                  if (!current) {
                    yield* tx
                      .insert(WorkControllerDispatchTable)
                      .values({
                        goal_id: goalID,
                        signal,
                        revision: 1,
                        time_requested: now,
                        time_updated: now,
                      })
                      .run()
                      .pipe(Effect.orDie)
                    return
                  }
                  yield* tx
                    .update(WorkControllerDispatchTable)
                    .set({
                      signal,
                      revision: current.revision + 1,
                      time_requested: now,
                      time_updated: now,
                    })
                    .where(eq(WorkControllerDispatchTable.goal_id, goalID))
                    .run()
                    .pipe(Effect.orDie)
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
        }),
        claim: Effect.fn("WorkController.claim")(function* (claimOptions) {
          const now = yield* Clock.currentTimeMillis
          return yield* db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  const controller = yield* tx
                    .select()
                    .from(WorkControllerTable)
                    .where(eq(WorkControllerTable.id, controllerID))
                    .get()
                    .pipe(Effect.orDie)
                  if (
                    !controller ||
                    controller.runtime_id !== runtimeID ||
                    controller.expires_at <= now ||
                    controller.draining
                  )
                    return []
                  const query = tx.select().from(WorkControllerDispatchTable)
                  const candidates = yield* (
                    claimOptions?.goalID
                      ? query.where(eq(WorkControllerDispatchTable.goal_id, claimOptions.goalID)).all()
                      : query.orderBy(asc(WorkControllerDispatchTable.time_requested)).all()
                  ).pipe(Effect.orDie)
                  const claims: Claim[] = []
                  for (const candidate of candidates) {
                    if (claims.length >= Math.min(Math.max(claimOptions?.limit ?? 8, 1), 32)) break
                    if (candidate.revision <= candidate.processed_revision) continue
                    if (candidate.lease_expires_at !== null && candidate.lease_expires_at > now) continue
                    const lease = yield* tx
                      .select()
                      .from(WorkLeaseTable)
                      .where(eq(WorkLeaseTable.goal_id, candidate.goal_id))
                      .get()
                      .pipe(Effect.orDie)
                    if (
                      lease &&
                      lease.expires_at > now &&
                      (lease.controller_id !== controllerID || lease.controller_runtime_id !== runtimeID)
                    )
                      continue
                    const claim = {
                      goalID: candidate.goal_id,
                      controllerID,
                      runtimeID,
                      revision: candidate.revision,
                      fence: candidate.fence + 1,
                      signal: candidate.signal,
                    } satisfies Claim
                    yield* tx
                      .update(WorkControllerDispatchTable)
                      .set({
                        controller_id: controllerID,
                        runtime_id: runtimeID,
                        fence: claim.fence,
                        lease_expires_at: now + dispatchDurationMs,
                        time_updated: now,
                      })
                      .where(eq(WorkControllerDispatchTable.goal_id, candidate.goal_id))
                      .run()
                      .pipe(Effect.orDie)
                    claims.push(claim)
                  }
                  return claims
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
        }),
        run: (claim, use) => {
          const heartbeat = renew(claim).pipe(
            Effect.repeat(Schedule.spaced(dispatchHeartbeatMs)),
            Effect.andThen(Effect.never),
          )
          return use.pipe(
            Effect.raceFirst(heartbeat),
            Effect.onExit((exit) => (Exit.isSuccess(exit) ? complete(claim) : release(claim))),
          )
        },
        interrupts: Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const rows = yield* db
            .select({ dispatch: WorkControllerDispatchTable, lease: WorkLeaseTable })
            .from(WorkControllerDispatchTable)
            .innerJoin(WorkLeaseTable, eq(WorkLeaseTable.goal_id, WorkControllerDispatchTable.goal_id))
            .where(
              and(
                eq(WorkControllerDispatchTable.signal, "interrupt"),
                eq(WorkLeaseTable.controller_id, controllerID),
                eq(WorkLeaseTable.controller_runtime_id, runtimeID),
                gt(WorkLeaseTable.expires_at, now),
              ),
            )
            .all()
            .pipe(Effect.orDie)
          return rows
            .filter((row) => row.dispatch.revision > row.dispatch.processed_revision)
            .map((row) => row.dispatch.goal_id)
        }),
        activeGoals: Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          return new Set(
            (yield* db
              .select({ goalID: WorkLeaseTable.goal_id })
              .from(WorkLeaseTable)
              .where(gt(WorkLeaseTable.expires_at, now))
              .all()
              .pipe(Effect.orDie)).map((row) => row.goalID),
          )
        }),
        setDraining: Effect.fn("WorkController.setDraining")(function* (draining) {
          const now = yield* Clock.currentTimeMillis
          const row = yield* db
            .update(WorkControllerTable)
            .set({ draining, time_heartbeat: now, expires_at: now + durationMs })
            .where(
              and(
                eq(WorkControllerTable.id, controllerID),
                eq(WorkControllerTable.runtime_id, runtimeID),
                gt(WorkControllerTable.expires_at, now),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* Effect.die(new CollisionError({ controllerID, runtimeID }))
          return info(row, now)
        }),
      })
    }),
  )
}

function info(row: typeof WorkControllerTable.$inferSelect, now: number) {
  return Work.ControllerInfo.make({
    id: row.id,
    runtimeID: row.runtime_id,
    label: row.label,
    endpoint: row.endpoint ?? undefined,
    status: row.expires_at <= now ? "offline" : row.draining ? "draining" : "online",
    startedAt: DateTime.makeUnsafe(row.time_started),
    heartbeatAt: DateTime.makeUnsafe(row.time_heartbeat),
    expiresAt: DateTime.makeUnsafe(row.expires_at),
  })
}

function dispatchInfo(row: typeof WorkControllerDispatchTable.$inferSelect, now: number) {
  return Work.ControllerDispatchInfo.make({
    goalID: row.goal_id,
    signal: row.signal,
    revision: row.revision,
    processedRevision: row.processed_revision,
    controllerID: row.controller_id ?? undefined,
    runtimeID: row.runtime_id ?? undefined,
    fence: row.fence,
    status:
      row.revision <= row.processed_revision
        ? "settled"
        : row.lease_expires_at !== null && row.lease_expires_at > now
          ? "leased"
          : "pending",
    leaseExpiresAt: row.lease_expires_at === null ? undefined : DateTime.makeUnsafe(row.lease_expires_at),
    requestedAt: DateTime.makeUnsafe(row.time_requested),
    updatedAt: DateTime.makeUnsafe(row.time_updated),
  })
}

function clean(value: string, limit: number) {
  return value.trim().slice(0, limit) || "ZAOVRA Controller"
}

function optionalText(value: string | undefined, limit: number) {
  const text = value?.trim().slice(0, limit)
  return text ? text : undefined
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
