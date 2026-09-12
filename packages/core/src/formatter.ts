export * as Formatter from "./formatter"

import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import path from "path"

import { Config } from "./config"
import { makeLocationNode } from "./effect/app-node"
import { FormatterBuiltins } from "./formatter/builtins"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { AppProcess } from "./process"

export const Result = Schema.Struct({ ran: Schema.Array(Schema.String), failed: Schema.Array(Schema.String) })
export type Result = typeof Result.Type

export interface Interface {
  readonly format: (file: string) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/v2/Formatter") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const entries = yield* config.entries()
    const settings = entries.reduce<Config.Info["formatter"]>((value, entry) => {
      if (entry.type !== "document" || entry.info.formatter === undefined) return value
      return typeof value === "object" && typeof entry.info.formatter === "object"
        ? Object.fromEntries(
            Object.entries({ ...value, ...entry.info.formatter }).map(([name, item]) => [
              name,
              { ...value[name], ...item, environment: { ...value[name]?.environment, ...item.environment } },
            ]),
          )
        : entry.info.formatter
    }, undefined)
    const builtins = FormatterBuiltins.create({
      findUp: (target, start, stop) => Effect.runPromise(fs.up({ targets: [target], start, stop })),
      readJson: <T>(file: string) => Effect.runPromise(fs.readJson(file).pipe(Effect.map((value) => value as T))),
      readText: (file) => Effect.runPromise(fs.readFileString(file)),
      probe: (command) =>
        Effect.runPromise(
          appProcess
            .run(ChildProcess.make(command[0]!, command.slice(1)), { timeout: "10 seconds" })
            .pipe(Effect.map((result) => ({ code: result.exitCode, text: result.stdout.toString("utf8") }))),
        ),
    })
    const formatters: Record<string, FormatterBuiltins.Info> = settings
      ? Object.fromEntries(Object.values(builtins).map((item) => [item.name, item]))
      : {}
    if (settings && settings !== true) {
      for (const [name, item] of Object.entries(settings)) {
        if (["ruff", "uv"].includes(name) && (settings.ruff?.disabled || settings.uv?.disabled)) {
          delete formatters.ruff
          delete formatters.uv
          continue
        }
        if (item.disabled) {
          delete formatters[name]
          continue
        }
        const existing = formatters[name]
        formatters[name] = {
          name,
          extensions: [...(item.extensions ?? existing?.extensions ?? [])],
          environment: { ...existing?.environment, ...item.environment },
          enabled: item.command ? async () => [...item.command!] : (existing?.enabled ?? (async () => false)),
        }
      }
    }
    return Service.of({
      format: Effect.fn("Formatter.format")(function* (file) {
        const result = { ran: [] as string[], failed: [] as string[] }
        for (const item of Object.values(formatters).filter((item) => item.extensions.includes(path.extname(file)))) {
          const command = yield* Effect.tryPromise(() =>
            item.enabled({
              directory: location.directory,
              worktree: location.project.directory,
              experimentalOxfmt: ["1", "true"].includes(
                process.env.ZAOVRA_EXPERIMENTAL_OXFMT ?? process.env.ZAOVRA_EXPERIMENTAL ?? "",
              ),
            }),
          ).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (command === false) continue
          if (!command?.length) {
            result.failed.push(item.name)
            continue
          }
          const args = command.map((part) => part.replaceAll("$FILE", file))
          const success = yield* appProcess
            .run(
              ChildProcess.make(args[0]!, args.slice(1), {
                cwd: location.directory,
                env: item.environment,
                extendEnv: true,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              }),
              { timeout: "30 seconds" },
            )
            .pipe(
              Effect.map((output) => output.exitCode === 0),
              Effect.catch(() => Effect.succeed(false)),
            )
          if (success) result.ran.push(item.name)
          if (!success) result.failed.push(item.name)
        }
        return result
      }),
    })
  }),
)

export const locationLayer = layer
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Location.node, FSUtil.node, AppProcess.node],
})
