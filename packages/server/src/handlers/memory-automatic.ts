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
        if (preference?.enabled && preference.count_binding) yield* waitForReadiness("catalog")
        return { data: preference ? view(preference, yield* automatic.countVerified(preference)) : null }
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
        return { data: view(preference, yield* automatic.countVerified(preference)) }
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
        return { data: view(preference, false) }
      }),
    ),
)

function view(preference: MemoryAutomaticStore.Preference, countVerified: boolean): Memory.AutomaticPreference {
  return {
    directory: preference.directory,
    generation: preference.generation,
    enabled: preference.enabled,
    countVerified,
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
    message:
      input.reason === "count"
        ? "当前模型线路尚未通过输入计数验证。请先确认并运行一次手动整理。"
        : "自动整理设置未完成，请刷新设置并核对目录、模型、额度和当前授权。",
  })
}
