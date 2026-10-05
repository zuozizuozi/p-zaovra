export * as SessionExecution from "./execution"

import { SessionOwnership } from "./ownership"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "../effect/layer-node"
import { Node } from "../effect/app-node"
import { SessionRunner } from "./runner/index"
import { SessionSchema } from "./schema"

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly exclusive?: (
    sessionID: SessionSchema.ID,
    operation: Effect.Effect<void>,
  ) => Effect.Effect<void, SessionRunner.RunError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Without a claim, starts or observes execution. A claim starts an exclusively owned drain whose caller must await cleanup. */
  readonly resume: (
    sessionID: SessionSchema.ID,
    claim?: SessionOwnership.Claim,
  ) => Effect.Effect<void, SessionRunner.RunError>
  /** Waits for current work without starting a provider turn. */
  readonly wait?: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Serializes one manual compaction with the Session drain. */
  readonly compact?: (sessionID: SessionSchema.ID) => Effect.Effect<boolean, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Interrupt active work owned by this process. Idle interruption is a no-op. */
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Routes execution from a Session ID to the runner owned by that Session's Location. */
export class Service extends Context.Service<Service, Interface>()("@zaovra/v2/SessionExecution") {}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    resume: (_sessionID, claim) => claim?.check ?? Effect.void,
    wait: () => Effect.void,
    compact: () => Effect.succeed(false),
    wake: () => Effect.void,
    interrupt: () => Effect.void,
  }),
)
