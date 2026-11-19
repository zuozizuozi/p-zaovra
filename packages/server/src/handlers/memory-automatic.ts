import { waitForReadiness } from "../location"
import { MemoryTidyExecution } from "@zaovra-ai/core/memory/tidy-execution"
import { Location } from "@zaovra-ai/core/location"
import { MemoryAutomatic } from "@zaovra-ai/core/memory/automatic"
import type { MemoryAutomaticStore } from "@zaovra-ai/core/memory/automatic-store"
import { MemoryTidyError } from "@zaovra-ai/protocol/groups/memory"
import { Memory } from "@zaovra-ai/schema/memory"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const MemoryAutomaticHandler = HttpApiBuilder.group(Api, "server.memoryAutomatic", (handlers) =>
  handlers
    .handle(
      "memory.getAutomatic",
      Effect.fn(function* () {
        const automatic = yield* MemoryAutomatic.Service
        const location = yield* Location.Service
        const preference = yield* automatic.get(location.directory)
        return { data: preference ? view(preference) : null }
      }),
    )
    .handle(
      "memory.confirmAutomatic",
      Effect.fn(function* (ctx) {
        const automatic = yield* MemoryAutomatic.Service
        const location = yield* Location.Service
        if (location.workspaceID) return yield* error({ reason: "unauthorized" })
        yield* waitForReadiness("catalog")
        const preference = yield* automatic
          .confirm(location.directory, ctx.payload, yield* MemoryTidyExecution.supportsSelection(ctx.payload.model))
          .pipe(Effect.mapError(error))
        return { data: view(preference) }
      }),
    )
    .handle(
      "memory.disableAutomatic",
      Effect.fn(function* (ctx) {
        const automatic = yield* MemoryAutomatic.Service
        const location = yield* Location.Service
        const preference = yield* automatic
          .disable(location.directory, ctx.payload.expected)
          .pipe(Effect.mapError(error))
        return { data: view(preference) }
      }),
    ),
)

function view(preference: MemoryAutomaticStore.Preference): Memory.AutomaticPreference {
  return {
    directory: preference.directory,
    generation: preference.generation,
    enabled: preference.enabled,
    model: preference.model,
    tokens: preference.token_limit,
    dailyTokens: preference.daily_limit,
    currentRun: preference.current_run,
    confirmedAt: preference.time_confirmed,
  }
}

function error(input: { reason: MemoryTidyError["reason"] }) {
  return new MemoryTidyError({
    reason: input.reason,
    message: "自动整理设置未完成，请刷新设置并核对目录、模型、额度和当前授权。",
  })
}
