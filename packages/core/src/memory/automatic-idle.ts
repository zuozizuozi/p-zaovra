export * as MemoryAutomaticIdle from "./automatic-idle"

import { and, eq, isNull, ne, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { BackgroundJob } from "../background-job"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionExecutionStatus } from "../session/execution-status"
import type { SessionSchema } from "../session/schema"
import { SessionInputTable, SessionMessageTable } from "../session/sql"
import { MemoryAutomaticRunTable } from "./automatic.sql"
import type { MemoryTidyStore } from "./tidy-store"

export interface Interface {
  /** Process-local work quiescence, not keyboard/OS idle or a cross-process lease. */
  readonly available: (except?: SessionSchema.ID) => Effect.Effect<boolean>
  /** Manual tasks keep their existing contract; automatic tasks yield to ordinary work. */
  readonly allows: (run: MemoryTidyStore.Run) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/MemoryAutomaticIdle") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const execution = yield* SessionExecutionStatus.Service
    const jobs = yield* BackgroundJob.Service
    const available = Effect.fn("MemoryAutomaticIdle.available")(function* (except?: SessionSchema.ID) {
      const active = yield* execution.active
      if (!active || [...active].some((id) => id !== except)) return false
      if ((yield* jobs.list()).some((job) => job.status === "running")) return false
      if (
        yield* database.db
          .select({ id: SessionInputTable.id })
          .from(SessionInputTable)
          .where(
            and(
              isNull(SessionInputTable.promoted_seq),
              isNull(SessionInputTable.cancelled_seq),
              ...(except ? [ne(SessionInputTable.session_id, except)] : []),
            ),
          )
          .get()
          .pipe(Effect.orDie)
      )
        return false
      if (
        yield* database.db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.type, "shell"),
              sql`json_extract(${SessionMessageTable.data}, '$.time.completed') IS NULL`,
              ...(except ? [ne(SessionMessageTable.session_id, except)] : []),
            ),
          )
          .get()
          .pipe(Effect.orDie)
      )
        return false
      // SQL work may yield. Do not accept a stale idle result after a drain starts.
      const current = yield* execution.active
      return current !== undefined && [...current].every((id) => id === except)
    })
    return Service.of({
      available,
      allows: (run) =>
        database.db
          .select({ id: MemoryAutomaticRunTable.run_id })
          .from(MemoryAutomaticRunTable)
          .where(eq(MemoryAutomaticRunTable.run_id, run.id))
          .get()
          .pipe(
            Effect.orDie,
            Effect.flatMap((automatic) => (automatic ? available(run.session_id) : Effect.succeed(true))),
          ),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, SessionExecutionStatus.node, BackgroundJob.node],
})
