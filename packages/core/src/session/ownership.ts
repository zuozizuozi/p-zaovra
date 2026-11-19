export * as SessionOwnership from "./ownership"

import { Context, Effect } from "effect"

/** Process-local execution authority; observers never acquire this capability. */
export type Claim = {
  readonly id: string
  readonly check: Effect.Effect<void>
  readonly memoryTidy?: {
    readonly runID: string
    readonly checkpoint?: string
    readonly tokens?: number
  }
}
export const Current = Context.Reference<Claim | undefined>("@zaovra/SessionOwnership", {
  defaultValue: () => undefined,
})
export const check = Effect.gen(function* () {
  const claim = yield* Current
  if (claim) yield* claim.check
})
