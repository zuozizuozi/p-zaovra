export * as SessionExecutionStatus from "./execution-status"

import { Context, Effect, Layer, Schema, Scope } from "effect"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "./schema"

/**
 * Orders execution status reports from one or more server processes. `epoch` is the start time of
 * the reporting process and `revision` counts its status changes, so a reader keeps whichever
 * report compares higher and a slow response can never overwrite a newer event.
 */
export const Version = Schema.Struct({ epoch: Schema.Finite, revision: Schema.Int })
export type Version = typeof Version.Type

/**
 * Whether this process is working on the Session right now. Process-local and never replayed: a
 * crashed process cannot announce that it stopped, so readers also ask again when they reconnect.
 */
export const Changed = EventV2.define({
  type: "session.execution.status",
  schema: { sessionID: SessionSchema.ID, active: Schema.Boolean, ...Version.fields },
})

/** Read-only observers must not depend on the execution router, which itself owns Locations. */
export interface Interface {
  /** Undefined means no unique live coordinator is bound; it does not mean idle. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID> | undefined>
  /** Host lifecycle binding only. Readers cannot start, stop or claim a Session. */
  readonly track: (active: Effect.Effect<ReadonlySet<SessionSchema.ID>>) => Effect.Effect<void, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/SessionExecutionStatus") {}

export const layer = Layer.sync(Service, () => {
  const sources = new Map<object, Effect.Effect<ReadonlySet<SessionSchema.ID>>>()
  return Service.of({
    active: Effect.suspend(() =>
      sources.size !== 1
        ? Effect.succeed(undefined)
        : [...sources.values()][0]!.pipe(Effect.map((active) => new Set(active))),
    ),
    track: (active) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const token = {}
          sources.set(token, active)
          return token
        }),
        (token) =>
          Effect.sync(() => {
            sources.delete(token)
          }),
      ).pipe(Effect.asVoid),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
