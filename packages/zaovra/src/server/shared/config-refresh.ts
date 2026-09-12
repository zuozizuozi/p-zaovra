export * as ConfigRefresh from "./config-refresh"

import { Effect, RcMap } from "effect"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { LocationServiceMap } from "@zaovra-ai/core/location-services"

export const refresh = Effect.fn("ConfigRefresh.refresh")(function* (directory?: string) {
  const locations = yield* LocationServiceMap.Service
  const refs = Array.from(yield* RcMap.keys(locations.rcMap))
  // RcMap invalidation keeps borrowed runtimes alive until their active scopes release them.
  yield* Effect.forEach(
    refs.filter((ref) => directory === undefined || FSUtil.contains(directory, ref.directory)),
    (ref) => locations.invalidate(ref),
    { discard: true },
  )
})
