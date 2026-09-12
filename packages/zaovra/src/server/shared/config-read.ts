export * as ConfigRead from "./config-read"

import { Cause, Effect, Exit, Option, Schema } from "effect"
import { Config } from "@zaovra-ai/core/config"
import { ConfigV1 } from "@zaovra-ai/core/v1/config/config"
import { ConfigErrorV1 } from "@zaovra-ai/core/v1/config/error"
import { Location } from "@zaovra-ai/core/location"
import { LocationServiceMap } from "@zaovra-ai/core/location-services"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { ConfigParse } from "@/config/parse"

// This is a read-only compatibility view for desktop preferences. Native
// providers, agents and ordered permissions remain owned by their V2 APIs.
export const preferences = Effect.fn("ConfigRead.preferences")(function* (
  legacy: Effect.Effect<ConfigV1.Info>,
  directory: string,
) {
  const result = yield* Effect.exit(legacy)
  if (Exit.isSuccess(result)) return result.value
  const error = Cause.squash(result.cause)
  if (!(error instanceof ConfigErrorV1.InvalidError)) return yield* Effect.failCause(result.cause)
  if (
    error.data.issues?.some(
      (issue: { code?: unknown; keys?: unknown }) =>
        issue.code === "unrecognized_keys" &&
        Array.isArray(issue.keys) &&
        issue.keys.some((key: unknown) => typeof key !== "string" || !Object.hasOwn(Config.Info.fields, key)),
    )
  )
    return yield* Effect.failCause(result.cause)
  const locations = yield* LocationServiceMap.Service
  return yield* Effect.gen(function* () {
    const config = yield* Config.Service
    const entries = yield* config.entries()
    const fs = yield* FSUtil.Service
    yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          if (entry.type !== "document" || !entry.path) return
          const text = yield* fs.readFileString(entry.path).pipe(Effect.orDie)
          ConfigParse.configuration(ConfigParse.jsonc(text, entry.path), entry.path)
        }),
      { discard: true },
    )
    const values = Object.fromEntries(
      Object.entries(ConfigV1.Info.fields).flatMap(([key, field]) => {
        if (!Object.hasOwn(Config.Info.fields, key)) return []
        const value = Config.latest(entries, key as keyof Config.Info)
        if (value === undefined) return []
        const decoded = Schema.decodeUnknownOption(field, { onExcessProperty: "error" })(value)
        return Option.isSome(decoded) ? [[key, decoded.value]] : []
      }),
    )
    const filters = entries.flatMap((entry) =>
      entry.type === "document" && entry.info.provider_filter ? [entry.info.provider_filter] : [],
    )
    return Schema.decodeUnknownSync(ConfigV1.Info)({
      ...values,
      disabled_providers: filters.findLast((filter) => filter.deny !== undefined)?.deny,
      enabled_providers: filters.findLast((filter) => filter.allow !== undefined)?.allow,
    })
  }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))))
})
