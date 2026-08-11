export * as TaskRecovery from "./task-recovery"

import { and, eq, isNotNull, isNull } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionExecution } from "../session/execution"
import { SessionSchema } from "../session/schema"
import { SessionInputTable, SessionTable } from "../session/sql"

export interface Interface {
  /** Wakes only child prompts that were durably admitted but never promoted. */
  readonly recover: () => Effect.Effect<ReadonlyArray<SessionSchema.ID>>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/TaskRecovery") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const execution = yield* SessionExecution.Service
    const recover = Effect.fn("TaskRecovery.recover")(function* () {
      const rows = yield* db
        .selectDistinct({ id: SessionTable.id })
        .from(SessionTable)
        .innerJoin(SessionInputTable, eq(SessionInputTable.session_id, SessionTable.id))
        .where(and(isNotNull(SessionTable.parent_id), isNull(SessionInputTable.promoted_seq)))
        .all()
        .pipe(Effect.orDie)
      const sessionIDs = rows.map((row) => SessionSchema.ID.make(row.id))
      yield* Effect.forEach(sessionIDs, execution.wake, { discard: true })
      return sessionIDs
    })
    return Service.of({ recover })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, SessionExecution.node] })

export const startupNode = makeGlobalNode({
  name: "task-recovery/startup",
  layer: Layer.effectDiscard(Service.use((service) => service.recover())),
  deps: [node],
})
