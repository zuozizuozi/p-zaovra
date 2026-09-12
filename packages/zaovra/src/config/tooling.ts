export * as ConfigTooling from "./tooling"

import { Cause, Effect, Exit, Layer } from "effect"
import { mergeDeep } from "remeda"
import { Config } from "@zaovra-ai/core/config"
import { ConfigErrorV1 } from "@zaovra-ai/core/v1/config/error"
import { ConfigV1 } from "@zaovra-ai/core/v1/config/config"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Location } from "@zaovra-ai/core/location"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import type { InstanceContext } from "@/project/instance-context"
import { ConfigParse } from "./parse"

// Only language-server and formatter options cross this boundary. Native
// permissions and provider definitions must never become legacy runtime config.
export const read = Effect.fn("ConfigTooling.read")(function* (
  legacy: Effect.Effect<ConfigV1.Info>,
  ctx: InstanceContext,
) {
  const result = yield* Effect.exit(legacy)
  if (Exit.isSuccess(result)) return { lsp: result.value.lsp, formatter: result.value.formatter }
  if (!(Cause.squash(result.cause) instanceof ConfigErrorV1.InvalidError)) return yield* Effect.failCause(result.cause)

  // Tooling state owns this snapshot and disposes it with the instance. Building
  // only Config avoids creating a second map of session/runtime services.
  return yield* Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const entries = yield* config.entries()
    yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        if (entry.type !== "document" || !entry.path) return
        const text = yield* fs.readFileString(entry.path).pipe(Effect.orDie)
        ConfigParse.configuration(ConfigParse.jsonc(text, entry.path), entry.path)
      }),
    )
    return entries.reduce<Pick<Config.Info, "lsp" | "formatter">>((options, entry) => {
      if (entry.type !== "document") return options
      return {
        lsp:
          typeof options.lsp === "object" && typeof entry.info.lsp === "object"
            ? mergeDeep(options.lsp, entry.info.lsp)
            : (entry.info.lsp ?? options.lsp),
        formatter:
          typeof options.formatter === "object" && typeof entry.info.formatter === "object"
            ? mergeDeep(options.formatter, entry.info.formatter)
            : (entry.info.formatter ?? options.formatter),
      }
    }, {})
  }).pipe(
    Effect.provide(
      LayerNode.compile(LayerNode.group([Config.node, FSUtil.node]), [
        [
          Location.node,
          Layer.succeed(Location.Service, {
            directory: AbsolutePath.make(ctx.directory),
            project: { id: ctx.project.id, directory: AbsolutePath.make(ctx.worktree) },
          }),
        ],
      ]),
    ),
  )
})
