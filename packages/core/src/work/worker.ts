export * as WorkWorker from "./worker"

import { Work } from "@zaovra-ai/schema/work"
import { and, asc, eq, inArray } from "drizzle-orm"
import { Clock, Context, DateTime, Effect, Layer, Schedule } from "effect"
import { timingSafeEqual } from "node:crypto"
import path from "path"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Hash } from "../util/hash"
import { WorkInfo } from "./info"
import { WorkGoalTable, WorkWorkerTable } from "./sql"

const DEFAULT_DURATION_MS = 15_000
const DEFAULT_HEARTBEAT_MS = 5_000
export const pollAfterMs = 2_000

export type Registration = {
  readonly id: Work.WorkerID
  readonly runtimeID?: Work.WorkerRuntimeID
  readonly label: string
  readonly endpoint?: string
  readonly capabilities: ReadonlyArray<Work.WorkerCapability>
  readonly workspaceRoots: ReadonlyArray<string>
  readonly executionMode?: Work.WorkerExecutionMode
  readonly locationMappings?: ReadonlyArray<Work.WorkerLocationMapping>
  readonly capacity?: number
  readonly draining?: boolean
}

export type EnrollmentRegistration = Omit<Registration, "id" | "draining">

export const defaultID = Work.WorkerID.make(process.env.ZAOVRA_WORKER_ID ?? "worker_local")

export interface Interface {
  readonly localID: Work.WorkerID
  readonly enroll: (registration: EnrollmentRegistration) => Effect.Effect<Work.WorkerEnrollment>
  readonly rotateCredential: (workerID: Work.WorkerID) => Effect.Effect<Work.WorkerEnrollment | undefined>
  readonly revokeCredential: (workerID: Work.WorkerID) => Effect.Effect<Work.WorkerInfo | undefined>
  readonly authenticate: (workerID: Work.WorkerID, token: string) => Effect.Effect<boolean>
  readonly heartbeat: (registration: Registration) => Effect.Effect<Work.WorkerInfo>
  readonly setDraining: (workerID: Work.WorkerID, draining: boolean) => Effect.Effect<Work.WorkerInfo | undefined>
  readonly get: (workerID: Work.WorkerID) => Effect.Effect<Work.WorkerInfo | undefined>
  readonly assignments: (workerID: Work.WorkerID) => Effect.Effect<ReadonlyArray<Work.WorkerAssignmentInfo>>
  readonly all: Effect.Effect<ReadonlyArray<Work.WorkerInfo>>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkWorker") {}

export const layer = makeLayer()

export function makeLayer(options?: {
  readonly local?: Registration
  readonly durationMs?: number
  readonly heartbeatMs?: number
  readonly automatic?: boolean
  readonly registerLocal?: boolean
}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const durationMs = options?.durationMs ?? DEFAULT_DURATION_MS
      const heartbeatMs = options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
      const local = options?.local ?? localRegistration()

      const map = (row: typeof WorkWorkerTable.$inferSelect, now: number) =>
        Work.WorkerInfo.make({
          id: row.id,
          runtimeID: row.runtime_id ?? undefined,
          label: row.label,
          endpoint: row.endpoint ?? undefined,
          capabilities: row.capabilities,
          workspaceRoots: row.workspace_roots,
          status: row.expires_at <= now ? "offline" : row.draining ? "draining" : "online",
          executionMode: row.execution_mode,
          capacity: row.capacity,
          locationMappings: row.location_mappings,
          credentialStatus: row.credential_hash
            ? "enrolled"
            : row.credential_created_at !== null || row.credential_revoked_at !== null
              ? "revoked"
              : "local",
          credentialCreatedAt:
            row.credential_created_at === null ? undefined : DateTime.makeUnsafe(row.credential_created_at),
          credentialLastUsedAt:
            row.credential_last_used_at === null ? undefined : DateTime.makeUnsafe(row.credential_last_used_at),
          credentialRevokedAt:
            row.credential_revoked_at === null ? undefined : DateTime.makeUnsafe(row.credential_revoked_at),
          createdAt: DateTime.makeUnsafe(row.time_created),
          heartbeatAt: DateTime.makeUnsafe(row.time_heartbeat),
          expiresAt: DateTime.makeUnsafe(row.expires_at),
        })

      const heartbeat = Effect.fn("WorkWorker.heartbeat")(function* (registration: Registration) {
        const now = yield* Clock.currentTimeMillis
        const current = yield* db
          .select()
          .from(WorkWorkerTable)
          .where(eq(WorkWorkerTable.id, registration.id))
          .get()
          .pipe(Effect.orDie)
        if (
          current?.runtime_id &&
          registration.runtimeID &&
          current.runtime_id !== registration.runtimeID &&
          current.expires_at > now
        )
          return map(current, now)
        const normalized = {
          ...normalizeRegistration(registration, current),
          runtime_id:
            current?.runtime_id && current.runtime_id !== registration.runtimeID && current.expires_at > now
              ? current.runtime_id
              : (registration.runtimeID ?? current?.runtime_id),
        }
        yield* db
          .insert(WorkWorkerTable)
          .values({
            id: registration.id,
            ...normalized,
            draining: registration.draining ?? current?.draining ?? false,
            time_created: current?.time_created ?? now,
            time_heartbeat: now,
            expires_at: now + durationMs,
          })
          .onConflictDoUpdate({
            target: WorkWorkerTable.id,
            set: {
              ...normalized,
              draining: registration.draining ?? current?.draining ?? false,
              time_heartbeat: now,
              expires_at: now + durationMs,
            },
          })
          .run()
          .pipe(Effect.orDie)
        return map(
          (yield* db
            .select()
            .from(WorkWorkerTable)
            .where(eq(WorkWorkerTable.id, registration.id))
            .get()
            .pipe(Effect.orDie))!,
          now,
        )
      })

      const get = Effect.fn("WorkWorker.get")(function* (workerID: Work.WorkerID) {
        const row = yield* db
          .select()
          .from(WorkWorkerTable)
          .where(eq(WorkWorkerTable.id, workerID))
          .get()
          .pipe(Effect.orDie)
        return row ? map(row, yield* Clock.currentTimeMillis) : undefined
      })

      if (options?.registerLocal !== false) {
        yield* heartbeat(local)
        if (options?.automatic !== false)
          yield* heartbeat(local).pipe(
            Effect.repeat(Schedule.spaced(heartbeatMs)),
            Effect.forkScoped({ startImmediately: true }),
          )
      }

      return Service.of({
        localID: local.id,
        enroll: Effect.fn("WorkWorker.enroll")(function* (registration) {
          const now = yield* Clock.currentTimeMillis
          const id = Work.WorkerID.create()
          const token = issueToken()
          yield* db
            .insert(WorkWorkerTable)
            .values({
              id,
              ...normalizeRegistration({ ...registration, id }, undefined, "remote"),
              draining: false,
              credential_hash: tokenHash(id, token),
              credential_created_at: now,
              credential_last_used_at: null,
              credential_revoked_at: null,
              time_created: now,
              time_heartbeat: now,
              expires_at: now,
            })
            .run()
            .pipe(Effect.orDie)
          return Work.WorkerEnrollment.make({ worker: (yield* get(id))!, token })
        }),
        rotateCredential: Effect.fn("WorkWorker.rotateCredential")(function* (workerID) {
          const token = issueToken()
          const now = yield* Clock.currentTimeMillis
          const updated = yield* db
            .update(WorkWorkerTable)
            .set({
              credential_hash: tokenHash(workerID, token),
              credential_created_at: now,
              credential_last_used_at: null,
              credential_revoked_at: null,
              runtime_id: null,
              expires_at: now,
            })
            .where(eq(WorkWorkerTable.id, workerID))
            .returning({ id: WorkWorkerTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return undefined
          return Work.WorkerEnrollment.make({ worker: (yield* get(workerID))!, token })
        }),
        revokeCredential: Effect.fn("WorkWorker.revokeCredential")(function* (workerID) {
          const now = yield* Clock.currentTimeMillis
          const updated = yield* db
            .update(WorkWorkerTable)
            .set({
              credential_hash: null,
              credential_last_used_at: null,
              credential_revoked_at: now,
              runtime_id: null,
              draining: true,
              expires_at: now,
            })
            .where(eq(WorkWorkerTable.id, workerID))
            .returning({ id: WorkWorkerTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return undefined
          return yield* get(workerID)
        }),
        authenticate: Effect.fn("WorkWorker.authenticate")(function* (workerID, token) {
          const current = yield* db
            .select({ hash: WorkWorkerTable.credential_hash })
            .from(WorkWorkerTable)
            .where(eq(WorkWorkerTable.id, workerID))
            .get()
            .pipe(Effect.orDie)
          if (!current?.hash || !matches(current.hash, tokenHash(workerID, token))) return false
          yield* db
            .update(WorkWorkerTable)
            .set({ credential_last_used_at: yield* Clock.currentTimeMillis })
            .where(eq(WorkWorkerTable.id, workerID))
            .run()
            .pipe(Effect.orDie)
          return true
        }),
        heartbeat,
        get,
        assignments: Effect.fn("WorkWorker.assignments")(function* (workerID) {
          return (yield* db
            .select()
            .from(WorkGoalTable)
            .where(
              and(
                eq(WorkGoalTable.worker_id, workerID),
                inArray(WorkGoalTable.status, ["active", "pausing", "cancelling"]),
              ),
            )
            .orderBy(asc(WorkGoalTable.time_updated), asc(WorkGoalTable.id))
            .all()
            .pipe(Effect.orDie)).map((row) => {
            const goal = WorkInfo.goal(row)
            return Work.WorkerAssignmentInfo.make({
              goalID: goal.id,
              location: goal.location,
              status: goal.status,
              action: goal.status === "active" ? "wake" : "recover",
              revision: goal.revision,
              updatedAt: goal.time.updated,
            })
          })
        }),
        all: Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          return (yield* db
            .select()
            .from(WorkWorkerTable)
            .orderBy(asc(WorkWorkerTable.label), asc(WorkWorkerTable.id))
            .all()
            .pipe(Effect.orDie)).map((row) => map(row, now))
        }),
        setDraining: Effect.fn("WorkWorker.setDraining")(function* (workerID, draining) {
          const current = yield* get(workerID)
          if (!current) return undefined
          yield* db
            .update(WorkWorkerTable)
            .set({ draining })
            .where(eq(WorkWorkerTable.id, workerID))
            .run()
            .pipe(Effect.orDie)
          return yield* get(workerID)
        }),
      })
    }),
  )
}

function normalizeRegistration(
  registration: Registration,
  current?: typeof WorkWorkerTable.$inferSelect,
  defaultMode: Work.WorkerExecutionMode = "shared",
) {
  return {
    label: registration.label.trim().slice(0, 200) || registration.id,
    runtime_id: registration.runtimeID ?? current?.runtime_id,
    capacity: Math.max(1, Math.min(32, Math.floor(registration.capacity ?? current?.capacity ?? 1))),
    endpoint: registration.endpoint?.trim().slice(0, 2_000),
    capabilities: Array.from(new Set(registration.capabilities)),
    workspace_roots: Array.from(new Set(registration.workspaceRoots.map((root) => root.trim()).filter(Boolean))).slice(
      0,
      64,
    ),
    execution_mode: registration.executionMode ?? current?.execution_mode ?? defaultMode,
    location_mappings: Array.from(
      new Map(
        (registration.locationMappings ?? current?.location_mappings ?? [])
          .map((mapping) => ({
            controllerRoot: mapping.controllerRoot.trim().slice(0, 2_000),
            workerRoot: mapping.workerRoot.trim().slice(0, 2_000),
          }))
          .filter((mapping) => mapping.controllerRoot && mapping.workerRoot)
          .map((mapping) => [`${mapping.controllerRoot}\u0000${mapping.workerRoot}`, mapping]),
      ).values(),
    ).slice(0, 64),
  }
}

function issueToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
}

function tokenHash(workerID: Work.WorkerID, token: string) {
  return Hash.sha256(`${workerID}:${token}`)
}

function matches(expected: string, actual: string) {
  if (expected.length !== actual.length) return false
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))
}

function localRegistration(): Registration {
  return {
    id: defaultID,
    label: process.env.ZAOVRA_WORKER_LABEL ?? process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? defaultID,
    endpoint: process.env.ZAOVRA_WORKER_ENDPOINT,
    capabilities: ["execute", "worktree", "mcp"],
    runtimeID: Work.WorkerRuntimeID.create(),
    capacity: 1,
    workspaceRoots: (process.env.ZAOVRA_WORKER_ROOTS ?? "*").split(path.delimiter),
    executionMode: "shared",
    locationMappings: [],
  }
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
