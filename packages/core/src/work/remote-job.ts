export * as WorkRemoteJob from "./remote-job"

import { Work } from "@zaovra-ai/schema/work"
import { and, asc, desc, eq, gt, inArray, lte } from "drizzle-orm"
import { Clock, Context, DateTime, Effect, Layer } from "effect"
import { isDeepStrictEqual } from "node:util"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Hash } from "../util/hash"
import { WorkArtifact } from "./artifact"
import { WorkWorkerJobArtifactTable, WorkWorkerJobLogTable, WorkWorkerJobTable, WorkWorkerTable } from "./sql"

const DEFAULT_LEASE_MS = 15_000
const DEFAULT_RECOVERY_GRACE_MS = 30_000
const MAX_RESULT_BYTES = 256 * 1024
export const maxLogBytes = 64 * 1024
export const maxJobLogBytes = 1024 * 1024
export const maxArtifactBytes = 4 * 1024 * 1024
const MAX_LOG_ENTRIES = 1_024
const MAX_ARTIFACTS = 16

export type DispatchInput = {
  readonly workerID?: Work.WorkerID
  readonly goalID: Work.GoalID
  readonly attemptID: Work.AttemptID
  readonly criterionID: Work.CriterionID
  readonly operation: Work.WorkerJobOperation
}

export type AppendLogInput = {
  readonly workerID: Work.WorkerID
  readonly runtimeID?: Work.WorkerRuntimeID
  readonly jobID: Work.WorkerJobID
  readonly fence: number
  readonly sequence: number
  readonly stream: Work.WorkerJobLogStream
  readonly message: string
}

export type UploadArtifactInput = {
  readonly workerID: Work.WorkerID
  readonly runtimeID?: Work.WorkerRuntimeID
  readonly jobID: Work.WorkerJobID
  readonly fence: number
  readonly label: string
  readonly digest: Work.ArtifactDigest
  readonly size: number
  readonly content: string
}

export type ClaimInput = {
  readonly workerID: Work.WorkerID
  readonly runtimeID: Work.WorkerRuntimeID
  readonly capacity: number
  readonly recoverableJobIDs: ReadonlyArray<Work.WorkerJobID>
}

export type ClaimOutput = {
  readonly jobs: ReadonlyArray<Work.WorkerJobAssignment>
  readonly cancellations: ReadonlyArray<Work.WorkerJobCancellation>
  readonly settledJobs: ReadonlyArray<Work.WorkerJobID>
}

export interface Interface {
  readonly dispatch: (input: DispatchInput) => Effect.Effect<Work.WorkerJobResult | undefined>
  readonly claim: (input: ClaimInput) => Effect.Effect<ClaimOutput>
  readonly renew: (input: {
    readonly workerID: Work.WorkerID
    readonly runtimeID?: Work.WorkerRuntimeID
    readonly jobID: Work.WorkerJobID
    readonly fence: number
  }) => Effect.Effect<boolean>
  readonly complete: (input: {
    readonly workerID: Work.WorkerID
    readonly runtimeID?: Work.WorkerRuntimeID
    readonly jobID: Work.WorkerJobID
    readonly fence: number
    readonly result: Work.WorkerJobResult
  }) => Effect.Effect<boolean>
  readonly requestCancel: (jobID: Work.WorkerJobID, reason: string) => Effect.Effect<boolean>
  readonly get: (jobID: Work.WorkerJobID) => Effect.Effect<Work.WorkerJobInfo | undefined>
  readonly list: (goalID: Work.GoalID) => Effect.Effect<ReadonlyArray<Work.WorkerJobInfo>>
  readonly logs: (jobID: Work.WorkerJobID) => Effect.Effect<ReadonlyArray<Work.WorkerJobLogEntry>>
  readonly appendLog: (input: AppendLogInput) => Effect.Effect<boolean>
  readonly uploadArtifact: (input: UploadArtifactInput) => Effect.Effect<Work.ArtifactReference | undefined>
  readonly artifact: (
    jobID: Work.WorkerJobID,
    digest: Work.ArtifactDigest,
  ) => Effect.Effect<Work.WorkerJobArtifactContent | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkRemoteJob") {}

export const layer = makeLayer()

export function makeLayer(options?: { readonly leaseMs?: number; readonly recoveryGraceMs?: number }) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const artifactStore = yield* WorkArtifact.Service
      const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS
      const recoveryGraceMs = options?.recoveryGraceMs ?? DEFAULT_RECOVERY_GRACE_MS

      const mapLog = (row: typeof WorkWorkerJobLogTable.$inferSelect) =>
        Work.WorkerJobLogEntry.make({
          jobID: row.job_id,
          sequence: row.sequence,
          stream: row.stream,
          message: row.message,
          size: row.size,
          createdAt: DateTime.makeUnsafe(row.time_created),
        })

      const mapArtifact = (row: typeof WorkWorkerJobArtifactTable.$inferSelect) =>
        Work.WorkerJobArtifactInfo.make({
          jobID: row.job_id,
          workerID: row.worker_id,
          fence: row.fence,
          label: row.label,
          artifact: Work.ArtifactReference.make({
            digest: row.digest,
            reference: row.reference,
            size: row.size,
            mediaType: row.media_type,
          }),
          createdAt: DateTime.makeUnsafe(row.time_created),
        })

      const map = (
        row: typeof WorkWorkerJobTable.$inferSelect,
        artifacts: ReadonlyArray<Work.WorkerJobArtifactInfo>,
        logs: ReadonlyArray<Work.WorkerJobLogEntry>,
      ) =>
        Work.WorkerJobInfo.make({
          id: row.id,
          workerID: row.worker_id,
          goalID: row.goal_id,
          attemptID: row.attempt_id,
          criterionID: row.criterion_id,
          status: row.status,
          runtimeID: row.lease_runtime_id ?? undefined,
          fence: row.fence,
          operation: row.operation,
          result: row.result ?? undefined,
          artifacts,
          logCount: logs.length,
          lastLog: logs.at(-1),
          leaseExpiresAt: row.lease_expires_at === null ? undefined : DateTime.makeUnsafe(row.lease_expires_at),
          cancelReason: row.cancel_reason ?? undefined,
          cancelRequestedAt:
            row.cancel_requested_at === null ? undefined : DateTime.makeUnsafe(row.cancel_requested_at),
          createdAt: DateTime.makeUnsafe(row.time_created),
          updatedAt: DateTime.makeUnsafe(row.time_updated),
          completedAt: row.time_completed === null ? undefined : DateTime.makeUnsafe(row.time_completed),
        })

      const getRow = Effect.fn("WorkRemoteJob.getRow")(function* (jobID: Work.WorkerJobID) {
        return yield* db
          .select()
          .from(WorkWorkerJobTable)
          .where(eq(WorkWorkerJobTable.id, jobID))
          .get()
          .pipe(Effect.orDie)
      })

      const logs = Effect.fn("WorkRemoteJob.logs")(function* (jobID: Work.WorkerJobID) {
        return (yield* db
          .select()
          .from(WorkWorkerJobLogTable)
          .where(eq(WorkWorkerJobLogTable.job_id, jobID))
          .orderBy(asc(WorkWorkerJobLogTable.sequence))
          .all()
          .pipe(Effect.orDie)).map(mapLog)
      })

      const artifacts = Effect.fn("WorkRemoteJob.artifacts")(function* (jobID: Work.WorkerJobID) {
        return (yield* db
          .select()
          .from(WorkWorkerJobArtifactTable)
          .where(eq(WorkWorkerJobArtifactTable.job_id, jobID))
          .orderBy(asc(WorkWorkerJobArtifactTable.time_created), asc(WorkWorkerJobArtifactTable.digest))
          .all()
          .pipe(Effect.orDie)).map(mapArtifact)
      })

      const get = Effect.fn("WorkRemoteJob.get")(function* (jobID: Work.WorkerJobID) {
        const row = yield* getRow(jobID)
        if (!row) return undefined
        return map(row, yield* artifacts(jobID), yield* logs(jobID))
      })

      const expire = Effect.fn("WorkRemoteJob.expire")(function* (jobID: Work.WorkerJobID) {
        const now = yield* Clock.currentTimeMillis
        yield* db
          .update(WorkWorkerJobTable)
          .set({ status: "unknown", time_updated: now, time_completed: now })
          .where(
            and(
              eq(WorkWorkerJobTable.id, jobID),
              inArray(WorkWorkerJobTable.status, ["leased", "cancelling"]),
              lte(WorkWorkerJobTable.lease_expires_at, now),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      })

      const terminal = Effect.fn("WorkRemoteJob.terminal")(function* (
        jobID: Work.WorkerJobID,
        operation: Work.WorkerJobOperation,
      ) {
        yield* expire(jobID)
        const row = yield* getRow(jobID)
        if (!row) return yield* Effect.die(`Remote Worker Job not found: ${jobID}`)
        const job = map(row, [], [])
        if (job.status === "completed") {
          if (!job.result) return yield* Effect.die(`Remote Worker Job ${jobID} completed without a result`)
          return job.result
        }
        if (job.status === "unknown") {
          const now = yield* Clock.currentTimeMillis
          if (row.time_completed !== null && now - row.time_completed < recoveryGraceMs) return undefined
          return unavailable(operation, `Remote Worker Job ${jobID} has an unknown outcome`)
        }
        if (job.status === "cancelled") return cancelled(operation, `Remote Worker Job ${jobID} was cancelled`)
        return undefined
      })

      const requestCancel = Effect.fn("WorkRemoteJob.requestCancel")(function* (
        jobID: Work.WorkerJobID,
        reason: string,
      ) {
        const now = yield* Clock.currentTimeMillis
        const current = yield* db
          .select({ status: WorkWorkerJobTable.status })
          .from(WorkWorkerJobTable)
          .where(eq(WorkWorkerJobTable.id, jobID))
          .get()
          .pipe(Effect.orDie)
        if (!current || !["queued", "leased", "cancelling"].includes(current.status)) return false
        const updated = yield* db
          .update(WorkWorkerJobTable)
          .set({
            status: current.status === "queued" ? "cancelled" : "cancelling",
            ...(current.status === "queued" ? {} : { cancel_reason: reason.slice(0, 2_000), cancel_requested_at: now }),
            time_updated: now,
            time_completed: current.status === "queued" ? now : null,
          })
          .where(
            and(
              eq(WorkWorkerJobTable.id, jobID),
              inArray(WorkWorkerJobTable.status, ["queued", "leased", "cancelling"]),
            ),
          )
          .returning({ id: WorkWorkerJobTable.id })
          .get()
          .pipe(Effect.orDie)
        return updated !== undefined
      })

      const dispatch = Effect.fn("WorkRemoteJob.dispatch")(function* (input: DispatchInput) {
        if (!input.workerID) return undefined
        const worker = yield* db
          .select({ mode: WorkWorkerTable.execution_mode })
          .from(WorkWorkerTable)
          .where(eq(WorkWorkerTable.id, input.workerID))
          .get()
          .pipe(Effect.orDie)
        if (worker?.mode !== "remote") return undefined

        const now = yield* Clock.currentTimeMillis
        const id = jobID(input)
        yield* db
          .insert(WorkWorkerJobTable)
          .values({
            id,
            worker_id: input.workerID,
            goal_id: input.goalID,
            attempt_id: input.attemptID,
            criterion_id: input.criterionID,
            status: "queued",
            fence: 0,
            operation: input.operation,
            time_created: now,
            time_updated: now,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const existing = yield* get(id)
        if (
          !existing ||
          existing.workerID !== input.workerID ||
          existing.goalID !== input.goalID ||
          existing.attemptID !== input.attemptID ||
          existing.criterionID !== input.criterionID ||
          !sameJson(existing.operation, input.operation)
        )
          return yield* Effect.die(`Conflicting reuse of Remote Worker Job ${id}`)

        return yield* Effect.scoped(
          Effect.gen(function* () {
            while (true) {
              const result = yield* terminal(id, input.operation)
              if (result) return result
              yield* Effect.sleep(250)
            }
          }),
        ).pipe(Effect.onInterrupt(() => requestCancel(id, "Controller interrupted the owning Work Attempt")))
      })

      const list = Effect.fn("WorkRemoteJob.list")(function* (goalID: Work.GoalID) {
        return yield* Effect.forEach(
          yield* db
            .select()
            .from(WorkWorkerJobTable)
            .where(eq(WorkWorkerJobTable.goal_id, goalID))
            .orderBy(asc(WorkWorkerJobTable.time_created), asc(WorkWorkerJobTable.id))
            .all()
            .pipe(Effect.orDie),
          (row) =>
            Effect.map(Effect.all([artifacts(row.id), logs(row.id)]), ([stored, entries]) => map(row, stored, entries)),
        )
      })

      const appendLog = Effect.fn("WorkRemoteJob.appendLog")(function* (input: AppendLogInput) {
        const entrySize = size(input.message)
        if (input.sequence < 1 || entrySize > maxLogBytes) return false
        const now = yield* Clock.currentTimeMillis
        return yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const job = yield* tx
                  .select({
                    workerID: WorkWorkerJobTable.worker_id,
                    runtimeID: WorkWorkerJobTable.lease_runtime_id,
                    status: WorkWorkerJobTable.status,
                    fence: WorkWorkerJobTable.fence,
                    leaseExpiresAt: WorkWorkerJobTable.lease_expires_at,
                  })
                  .from(WorkWorkerJobTable)
                  .where(eq(WorkWorkerJobTable.id, input.jobID))
                  .get()
                  .pipe(Effect.orDie)
                if (
                  !job ||
                  job.workerID !== input.workerID ||
                  (input.runtimeID !== undefined && job.runtimeID !== input.runtimeID) ||
                  !["leased", "cancelling"].includes(job.status) ||
                  job.fence !== input.fence ||
                  job.leaseExpiresAt === null ||
                  job.leaseExpiresAt <= now
                )
                  return false

                const existing = yield* tx
                  .select()
                  .from(WorkWorkerJobLogTable)
                  .where(
                    and(
                      eq(WorkWorkerJobLogTable.job_id, input.jobID),
                      eq(WorkWorkerJobLogTable.sequence, input.sequence),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
                if (existing)
                  return (
                    existing.worker_id === input.workerID &&
                    existing.fence === input.fence &&
                    existing.stream === input.stream &&
                    existing.message === input.message &&
                    existing.size === entrySize
                  )

                const entries = yield* tx
                  .select({ sequence: WorkWorkerJobLogTable.sequence, size: WorkWorkerJobLogTable.size })
                  .from(WorkWorkerJobLogTable)
                  .where(eq(WorkWorkerJobLogTable.job_id, input.jobID))
                  .orderBy(desc(WorkWorkerJobLogTable.sequence))
                  .all()
                  .pipe(Effect.orDie)
                if (
                  entries.length >= MAX_LOG_ENTRIES ||
                  input.sequence !== (entries[0]?.sequence ?? 0) + 1 ||
                  entries.reduce((total, entry) => total + entry.size, 0) + entrySize > maxJobLogBytes
                )
                  return false

                yield* tx
                  .insert(WorkWorkerJobLogTable)
                  .values({
                    job_id: input.jobID,
                    sequence: input.sequence,
                    worker_id: input.workerID,
                    fence: input.fence,
                    stream: input.stream,
                    message: input.message,
                    size: entrySize,
                    time_created: now,
                  })
                  .run()
                  .pipe(Effect.orDie)
                return true
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      })

      const uploadArtifact = Effect.fn("WorkRemoteJob.uploadArtifact")(function* (input: UploadArtifactInput) {
        if (
          input.label.length < 1 ||
          input.label.length > 200 ||
          input.size !== size(input.content) ||
          input.size > maxArtifactBytes ||
          input.digest !== hash(input.content)
        )
          return undefined
        const current = yield* getRow(input.jobID)
        const observedAt = yield* Clock.currentTimeMillis
        if (
          !current ||
          current.worker_id !== input.workerID ||
          (input.runtimeID !== undefined && current.lease_runtime_id !== input.runtimeID) ||
          !["leased", "cancelling"].includes(current.status) ||
          current.fence !== input.fence ||
          current.lease_expires_at === null ||
          current.lease_expires_at <= observedAt
        )
          return undefined

        const stored = yield* artifactStore.put(input.content).pipe(Effect.orDie)
        if (stored.digest !== input.digest || stored.size !== input.size) return undefined
        const committedAt = yield* Clock.currentTimeMillis
        const committed = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const job = yield* tx
                  .select({
                    workerID: WorkWorkerJobTable.worker_id,
                    runtimeID: WorkWorkerJobTable.lease_runtime_id,
                    status: WorkWorkerJobTable.status,
                    fence: WorkWorkerJobTable.fence,
                    leaseExpiresAt: WorkWorkerJobTable.lease_expires_at,
                  })
                  .from(WorkWorkerJobTable)
                  .where(eq(WorkWorkerJobTable.id, input.jobID))
                  .get()
                  .pipe(Effect.orDie)
                if (
                  !job ||
                  job.workerID !== input.workerID ||
                  (input.runtimeID !== undefined && job.runtimeID !== input.runtimeID) ||
                  !["leased", "cancelling"].includes(job.status) ||
                  job.fence !== input.fence ||
                  job.leaseExpiresAt === null ||
                  job.leaseExpiresAt <= committedAt
                )
                  return undefined

                const existing = yield* tx
                  .select()
                  .from(WorkWorkerJobArtifactTable)
                  .where(
                    and(
                      eq(WorkWorkerJobArtifactTable.job_id, input.jobID),
                      eq(WorkWorkerJobArtifactTable.digest, input.digest),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
                if (existing) {
                  if (
                    existing.worker_id !== input.workerID ||
                    existing.label !== input.label ||
                    existing.reference !== stored.reference ||
                    existing.size !== stored.size
                  )
                    return undefined
                  if (existing.fence !== input.fence)
                    yield* tx
                      .update(WorkWorkerJobArtifactTable)
                      .set({ fence: input.fence })
                      .where(
                        and(
                          eq(WorkWorkerJobArtifactTable.job_id, input.jobID),
                          eq(WorkWorkerJobArtifactTable.digest, input.digest),
                        ),
                      )
                      .run()
                      .pipe(Effect.orDie)
                  return stored
                }

                const count = yield* tx
                  .select({ digest: WorkWorkerJobArtifactTable.digest })
                  .from(WorkWorkerJobArtifactTable)
                  .where(eq(WorkWorkerJobArtifactTable.job_id, input.jobID))
                  .all()
                  .pipe(Effect.orDie)
                if (count.length >= MAX_ARTIFACTS) return undefined
                yield* tx
                  .insert(WorkWorkerJobArtifactTable)
                  .values({
                    job_id: input.jobID,
                    digest: input.digest,
                    worker_id: input.workerID,
                    fence: input.fence,
                    label: input.label,
                    reference: stored.reference,
                    size: stored.size,
                    media_type: stored.mediaType,
                    time_created: committedAt,
                  })
                  .run()
                  .pipe(Effect.orDie)
                return stored
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        if (committed)
          yield* artifactStore.retain(committed, { type: "worker-job", id: input.jobID }).pipe(Effect.orDie)
        return committed
      })

      const artifact = Effect.fn("WorkRemoteJob.artifact")(function* (
        jobID: Work.WorkerJobID,
        digest: Work.ArtifactDigest,
      ) {
        const row = yield* db
          .select()
          .from(WorkWorkerJobArtifactTable)
          .where(and(eq(WorkWorkerJobArtifactTable.job_id, jobID), eq(WorkWorkerJobArtifactTable.digest, digest)))
          .get()
          .pipe(Effect.orDie)
        if (!row) return undefined
        const info = mapArtifact(row)
        return Work.WorkerJobArtifactContent.make({
          artifact: info,
          content: yield* artifactStore.get(info.artifact).pipe(Effect.orDie),
        })
      })

      return Service.of({
        dispatch,
        get,
        list,
        logs,
        appendLog,
        uploadArtifact,
        artifact,
        claim: Effect.fn("WorkRemoteJob.claim")(function* (input) {
          const now = yield* Clock.currentTimeMillis
          const claimed = yield* db
            .transaction(
              (tx) =>
                Effect.gen(function* () {
                  const worker = yield* tx
                    .select({
                      mode: WorkWorkerTable.execution_mode,
                      runtimeID: WorkWorkerTable.runtime_id,
                      draining: WorkWorkerTable.draining,
                      expiresAt: WorkWorkerTable.expires_at,
                    })
                    .from(WorkWorkerTable)
                    .where(eq(WorkWorkerTable.id, input.workerID))
                    .get()
                    .pipe(Effect.orDie)
                  if (
                    !worker ||
                    worker.mode !== "remote" ||
                    worker.runtimeID !== input.runtimeID ||
                    worker.expiresAt <= now
                  )
                    return { rows: [], cancellations: [], settledJobs: [] }

                  const expired = yield* tx
                    .select({ id: WorkWorkerJobTable.id })
                    .from(WorkWorkerJobTable)
                    .where(
                      and(
                        eq(WorkWorkerJobTable.worker_id, input.workerID),
                        inArray(WorkWorkerJobTable.status, ["leased", "cancelling"]),
                        lte(WorkWorkerJobTable.lease_expires_at, now),
                      ),
                    )
                    .all()
                    .pipe(Effect.orDie)
                  if (expired.length > 0)
                    yield* tx
                      .update(WorkWorkerJobTable)
                      .set({
                        status: "unknown",
                        lease_runtime_id: null,
                        time_updated: now,
                        time_completed: now,
                      })
                      .where(
                        inArray(
                          WorkWorkerJobTable.id,
                          expired.map((job) => job.id),
                        ),
                      )
                      .run()
                      .pipe(Effect.orDie)

                  const current = yield* tx
                    .select()
                    .from(WorkWorkerJobTable)
                    .where(eq(WorkWorkerJobTable.worker_id, input.workerID))
                    .orderBy(asc(WorkWorkerJobTable.time_created), asc(WorkWorkerJobTable.id))
                    .all()
                    .pipe(Effect.orDie)
                  const recoverable = new Set(input.recoverableJobIDs.slice(0, 32))
                  const settledJobs = current
                    .filter((job) => recoverable.has(job.id) && ["completed", "cancelled"].includes(job.status))
                    .map((job) => job.id)
                  const capacity = Math.max(1, Math.min(32, Math.floor(input.capacity)))
                  const active = current.filter(
                    (job) =>
                      ["leased", "cancelling"].includes(job.status) &&
                      job.lease_expires_at !== null &&
                      job.lease_expires_at > now,
                  )
                  const sameRuntime = active.filter(
                    (job) => job.lease_runtime_id === input.runtimeID && recoverable.has(job.id),
                  )
                  const rebound = yield* Effect.forEach(
                    sameRuntime,
                    (job) =>
                      tx
                        .update(WorkWorkerJobTable)
                        .set({ lease_expires_at: now + leaseMs, time_updated: now })
                        .where(
                          and(
                            eq(WorkWorkerJobTable.id, job.id),
                            eq(WorkWorkerJobTable.fence, job.fence),
                            eq(WorkWorkerJobTable.lease_runtime_id, input.runtimeID),
                            inArray(WorkWorkerJobTable.status, ["leased", "cancelling"]),
                          ),
                        )
                        .returning()
                        .get()
                        .pipe(Effect.orDie),
                    { concurrency: 1 },
                  )
                  const remaining = Math.max(0, capacity - active.length)
                  const recoveries = yield* Effect.forEach(
                    current.filter((job) => job.status === "unknown" && recoverable.has(job.id)).slice(0, remaining),
                    (job) =>
                      tx
                        .update(WorkWorkerJobTable)
                        .set({
                          status: job.cancel_reason ? "cancelling" : "leased",
                          lease_runtime_id: input.runtimeID,
                          fence: job.fence + 1,
                          lease_expires_at: now + leaseMs,
                          time_updated: now,
                          time_completed: null,
                        })
                        .where(and(eq(WorkWorkerJobTable.id, job.id), eq(WorkWorkerJobTable.status, "unknown")))
                        .returning()
                        .get()
                        .pipe(Effect.orDie),
                    { concurrency: 1 },
                  )
                  const slots = Math.max(0, remaining - recoveries.filter(Boolean).length)
                  const queued = worker.draining ? [] : current.filter((job) => job.status === "queued").slice(0, slots)
                  const fresh = yield* Effect.forEach(
                    queued,
                    (job) =>
                      tx
                        .update(WorkWorkerJobTable)
                        .set({
                          status: "leased",
                          lease_runtime_id: input.runtimeID,
                          fence: job.fence + 1,
                          lease_expires_at: now + leaseMs,
                          time_updated: now,
                        })
                        .where(and(eq(WorkWorkerJobTable.id, job.id), eq(WorkWorkerJobTable.status, "queued")))
                        .returning()
                        .get()
                        .pipe(Effect.orDie),
                    { concurrency: 1 },
                  )
                  const rows = [
                    ...rebound.filter((job) => job !== undefined).map((job) => ({ job, recovered: true })),
                    ...recoveries.filter((job) => job !== undefined).map((job) => ({ job, recovered: true })),
                    ...fresh.filter((job) => job !== undefined).map((job) => ({ job, recovered: false })),
                  ]
                  const cancellations = (yield* tx
                    .select()
                    .from(WorkWorkerJobTable)
                    .where(
                      and(
                        eq(WorkWorkerJobTable.worker_id, input.workerID),
                        eq(WorkWorkerJobTable.lease_runtime_id, input.runtimeID),
                        eq(WorkWorkerJobTable.status, "cancelling"),
                        gt(WorkWorkerJobTable.lease_expires_at, now),
                      ),
                    )
                    .all()
                    .pipe(Effect.orDie)).map((job) =>
                    Work.WorkerJobCancellation.make({
                      id: job.id,
                      runtimeID: input.runtimeID,
                      fence: job.fence,
                      reason: job.cancel_reason ?? "Controller requested cancellation",
                      requestedAt: DateTime.makeUnsafe(job.cancel_requested_at ?? now),
                    }),
                  )
                  return {
                    rows,
                    cancellations,
                    settledJobs,
                  }
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
          const jobs = yield* Effect.forEach(claimed.rows, ({ job, recovered }) =>
            logs(job.id).pipe(
              Effect.map((entries) =>
                Work.WorkerJobAssignment.make({
                  id: job.id,
                  goalID: job.goal_id,
                  attemptID: job.attempt_id,
                  criterionID: job.criterion_id,
                  runtimeID: input.runtimeID,
                  fence: job.fence,
                  operation: job.operation,
                  recovered,
                  nextLogSequence: (entries.at(-1)?.sequence ?? 0) + 1,
                  leaseExpiresAt: DateTime.makeUnsafe(job.lease_expires_at!),
                }),
              ),
            ),
          )
          return { jobs, cancellations: claimed.cancellations, settledJobs: claimed.settledJobs }
        }),
        renew: Effect.fn("WorkRemoteJob.renew")(function* (input) {
          const now = yield* Clock.currentTimeMillis
          return (
            (yield* db
              .update(WorkWorkerJobTable)
              .set({ lease_expires_at: now + leaseMs, time_updated: now })
              .where(
                and(
                  eq(WorkWorkerJobTable.id, input.jobID),
                  eq(WorkWorkerJobTable.worker_id, input.workerID),
                  ...(input.runtimeID ? [eq(WorkWorkerJobTable.lease_runtime_id, input.runtimeID)] : []),
                  inArray(WorkWorkerJobTable.status, ["leased", "cancelling"]),
                  eq(WorkWorkerJobTable.fence, input.fence),
                  gt(WorkWorkerJobTable.lease_expires_at, now),
                ),
              )
              .returning({ id: WorkWorkerJobTable.id })
              .get()
              .pipe(Effect.orDie)) !== undefined
          )
        }),
        complete: Effect.fn("WorkRemoteJob.complete")(function* (input) {
          if (new TextEncoder().encode(JSON.stringify(input.result)).byteLength > MAX_RESULT_BYTES) return false
          const current = yield* get(input.jobID)
          if (
            !current ||
            current.workerID !== input.workerID ||
            (input.runtimeID !== undefined && current.runtimeID !== input.runtimeID) ||
            current.fence !== input.fence ||
            current.operation.type !== input.result.type ||
            !validCompletion(current, input.result) ||
            (current.status === "cancelling" && !interrupted(input.result))
          )
            return false
          if (current.status === "completed") return sameJson(current.result, input.result)
          const now = yield* Clock.currentTimeMillis
          const updated = yield* db
            .update(WorkWorkerJobTable)
            .set({
              status: "completed",
              result: input.result,
              time_updated: now,
              time_completed: now,
            })
            .where(
              and(
                eq(WorkWorkerJobTable.id, input.jobID),
                eq(WorkWorkerJobTable.worker_id, input.workerID),
                ...(input.runtimeID ? [eq(WorkWorkerJobTable.lease_runtime_id, input.runtimeID)] : []),
                inArray(WorkWorkerJobTable.status, ["leased", "cancelling"]),
                eq(WorkWorkerJobTable.fence, input.fence),
                gt(WorkWorkerJobTable.lease_expires_at, now),
              ),
            )
            .returning({ id: WorkWorkerJobTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!updated) {
            const completed = yield* get(input.jobID)
            return (
              completed?.status === "completed" &&
              completed.workerID === input.workerID &&
              (input.runtimeID === undefined || completed.runtimeID === input.runtimeID) &&
              completed.fence === input.fence &&
              sameJson(completed.result, input.result)
            )
          }
          return true
        }),
        requestCancel,
      })
    }),
  )
}

function jobID(input: DispatchInput) {
  return Work.WorkerJobID.make(
    `worker_job_${Hash.sha256(`${input.attemptID}:${input.criterionID}`).slice(0, 32)}`,
  )
}

function unavailable(operation: Work.WorkerJobOperation, error: string): Work.WorkerJobResult {
  if (operation.type === "command")
    return Work.WorkerCommandResult.make({ type: operation.type, error, outputTruncated: false })
  if (operation.type === "file") return Work.WorkerFileResult.make({ type: operation.type, error })
  return Work.WorkerAgentResult.make({
    type: operation.type,
    sessionID: operation.sessionID,
    status: "unknown",
    outputTruncated: false,
    stepCount: 0,
    toolCallCount: 0,
    error,
  })
}

function cancelled(operation: Work.WorkerJobOperation, error: string): Work.WorkerJobResult {
  if (operation.type === "command")
    return Work.WorkerCommandResult.make({ type: "command", interrupted: true, error, outputTruncated: false })
  if (operation.type === "file") return Work.WorkerFileResult.make({ type: "file", error })
  return Work.WorkerAgentResult.make({
    type: "agent",
    sessionID: operation.sessionID,
    status: "interrupted",
    outputTruncated: false,
    stepCount: 0,
    toolCallCount: 0,
    error,
  })
}

function interrupted(result: Work.WorkerJobResult) {
  if (result.type === "agent") return result.status === "interrupted"
  if (result.type === "command") return result.interrupted === true
  return result.error !== undefined
}

function validCompletion(job: Work.WorkerJobInfo, result: Work.WorkerJobResult) {
  if (result.type === "file" || job.operation.type === "file") return result.type === job.operation.type
  if (result.type !== job.operation.type) return false
  if (result.type === "agent") {
    if (job.operation.type !== "agent" || result.sessionID !== job.operation.sessionID) return false
    if ((result.finalResponse === undefined) !== (result.responseDigest === undefined)) return false
    if (result.finalResponse !== undefined && result.responseDigest !== hash(result.finalResponse)) return false
    if (result.status === "succeeded" && result.finalResponse === undefined) return false
  }
  const references = result.artifacts ?? []
  const capture = job.operation.artifactCapture
  if (!capture)
    return references.length === 0 && !result.baseRevision && !result.artifactError && job.artifacts.length === 0
  if (result.baseRevision && result.baseRevision !== capture.baseRevision) return false
  if (result.type === "command" && result.exitCode !== undefined && result.baseRevision !== capture.baseRevision)
    return false
  if (result.type === "agent" && !result.error && result.baseRevision !== capture.baseRevision) return false
  if (new Set(references.map((artifact) => artifact.digest)).size !== references.length) return false
  if (references.length !== job.artifacts.length) return false
  if (
    result.type === "agent" &&
    !result.artifactError &&
    result.workspaceDigest !== (references[0]?.digest ?? hash(""))
  )
    return false
  return references.every((reference) =>
    job.artifacts.some((stored) => isDeepStrictEqual(stored.artifact, reference) && stored.fence === job.fence),
  )
}

export function agentCriterionID(attemptID: Work.AttemptID) {
  return Work.CriterionID.make(`criterion_agent_${attemptID.slice("attempt_".length)}`)
}

function hash(value: string) {
  return Hash.sha256(value)
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function size(value: string) {
  return new TextEncoder().encode(value).byteLength
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, WorkArtifact.node] })
