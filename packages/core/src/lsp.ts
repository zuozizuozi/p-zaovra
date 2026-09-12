export * as LSP from "./lsp"

import { Context, Data, Effect, Layer, Option, Schema, ScopedCache } from "effect"
import path from "path"
import { Config } from "./config"
import { makeLocationNode } from "./effect/app-node"
import { KeyedMutex } from "./effect/keyed-mutex"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { LSPClient } from "./lsp/client"
import { LSPProcess } from "./lsp/process"
import { LSPBuiltins } from "./lsp/builtins"
import { LSPRuntime } from "./lsp/runtime"
import { AppProcess } from "./process"
import { EventV2 } from "./event"
import { LspEvent } from "@zaovra-ai/schema/lsp-event"

export interface Result {
  readonly diagnostics: Record<string, LSPClient.Diagnostic[]>
  readonly failed: string[]
}

const Position = Schema.Struct({ line: Schema.Number, character: Schema.Number })
export const Report = Schema.Struct({
  diagnostics: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        range: Schema.Struct({ start: Position, end: Position }),
        message: Schema.String,
        severity: Schema.Number.pipe(Schema.optional),
        source: Schema.String.pipe(Schema.optional),
      }),
    ),
  ),
  failed: Schema.Array(Schema.String),
})

export function describe(report: typeof Report.Type | undefined) {
  if (!report) return ""
  const issues = Object.entries(report.diagnostics).flatMap(([file, diagnostics]) =>
    diagnostics.map(
      (issue) =>
        `${file}:${issue.range.start.line + 1}:${issue.range.start.character + 1} ${issue.severity === 1 ? "ERROR" : issue.severity === 2 ? "WARNING" : "INFO"}: ${issue.message}`,
    ),
  )
  return [
    ...issues.slice(0, 20),
    ...(issues.length > 20 ? [`${issues.length - 20} more diagnostics omitted.`] : []),
    ...(report.failed.length
      ? [`Language diagnostics unavailable: ${report.failed.join(", ")}. File changes remain saved.`]
      : []),
  ].join("\n")
}

export interface Interface {
  readonly changed: (file: string) => Effect.Effect<Result>
  readonly removed: (file: string) => Effect.Effect<Result>
  readonly status: () => Effect.Effect<Status[]>
}

export interface Status {
  id: string
  name: string
  root: string
  status: "connected" | "error"
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/v2/LSP") {}

class ClientKey extends Data.Class<{ name: string; root: string }> {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const processService = yield* AppProcess.Service
    const events = yield* EventV2.Service
    const runFork = Effect.runForkWith(yield* Effect.context<never>())
    const entries = yield* config.entries()
    const settings = entries.reduce<Config.Info["lsp"]>((value, entry) => {
      if (entry.type !== "document" || entry.info.lsp === undefined) return value
      return typeof value === "object" && typeof entry.info.lsp === "object"
        ? { ...value, ...entry.info.lsp }
        : entry.info.lsp
    }, undefined)
    const overrides = settings && typeof settings === "object" ? settings : {}
    const flags = {
      disableLspDownload: /^(true|1)$/i.test(process.env.ZAOVRA_DISABLE_LSP_DOWNLOAD ?? ""),
      experimentalLspTy: /^(true|1)$/i.test(process.env.ZAOVRA_EXPERIMENTAL_LSP_TY ?? ""),
    }
    const context = { directory: location.directory, worktree: location.project.directory }
    const runtime = yield* LSPRuntime.make()
    const servers: Record<string, Pick<LSPBuiltins.Info, "id" | "root" | "extensions">> = settings
      ? Object.fromEntries(
          Object.values(LSPBuiltins.create(runtime))
            .filter((server) => server.id !== (flags.experimentalLspTy ? "pyright" : "ty"))
            .map((server) => [server.id, server]),
        )
      : {}
    for (const [name, server] of Object.entries(overrides)) {
      if (server.disabled) {
        delete servers[name]
        continue
      }
      servers[name] = {
        ...servers[name],
        id: name,
        extensions: [...(server.extensions ?? servers[name]?.extensions ?? [])],
        root: servers[name]?.root ?? (async () => location.directory),
      }
    }
    const states = new Map<string, Status>()
    const setStatus = Effect.fn("LSP.setStatus")(function* (
      key: { name: string; root: string },
      status: Status["status"],
    ) {
      const id = JSON.stringify([key.name, key.root])
      if (states.get(id)?.status === status) return
      states.set(id, {
        id: key.name,
        name: key.name,
        root: path.relative(location.directory, key.root),
        status,
      })
      yield* events.publish(
        LspEvent.Updated,
        {},
        { location: Location.Ref.make({ directory: location.directory, workspaceID: location.workspaceID }) },
      )
    })
    const clients = yield* ScopedCache.make({
      capacity: Number.POSITIVE_INFINITY,
      lookup: (key: { name: string; root: string }) =>
        Effect.gen(function* () {
          const runtime = yield* LSPRuntime.make()
          const configured = overrides[key.name]
          if (configured && !configured.disabled)
            return yield* LSPProcess.open({
              serverID: key.name,
              root: key.root,
              directory: location.directory,
              command: configured.command,
              environment: configured.env,
              initialization: configured.initialization,
            })
          const definition = Object.values(LSPBuiltins.create(runtime)).find((server) => server.id === key.name)
          if (!definition) return undefined
          const server = yield* Effect.tryPromise(() => definition.spawn(key.root, context, flags))
          if (!server) return undefined
          return yield* LSPProcess.open({ serverID: key.name, root: key.root, directory: location.directory, server })
        }).pipe(
          Effect.provideService(FSUtil.Service, fs),
          Effect.provideService(AppProcess.Service, processService),
          Effect.tap((client) =>
            Effect.gen(function* () {
              if (!client) return
              client.connection.onDispose(() => runFork(setStatus(key, "error")))
              yield* setStatus(key, "connected")
            }),
          ),
          Effect.tapError(() => setStatus(key, "error")),
          Effect.onInterrupt(() => setStatus(key, "error")),
        ),
    })
    const locks = KeyedMutex.makeUnsafe<string>()
    return Service.of({
      status: () => Effect.sync(() => Array.from(states.values())),
      removed: Effect.fn("LSP.removed")((file) =>
        Effect.gen(function* () {
          const result: Result = { diagnostics: {}, failed: [] }
          if (!FSUtil.contains(location.directory, file) && !FSUtil.contains(location.project.directory, file))
            return result
          for (const key of yield* ScopedCache.keys(clients)) {
            if (!FSUtil.contains(key.root, file)) continue
            yield* Effect.gen(function* () {
              const cached = yield* ScopedCache.getSuccess(clients, key)
              const client = Option.getOrUndefined(cached)
              if (!client) return
              yield* Effect.tryPromise(() => client.notify.remove({ path: file }))
              result.diagnostics[file] = []
            }).pipe(
              Effect.catch(() => {
                result.failed.push(key.name)
                return ScopedCache.invalidate(clients, key)
              }),
              Effect.onInterrupt(() => ScopedCache.invalidate(clients, key)),
              locks.withLock(JSON.stringify([key.name, key.root])),
            )
          }
          return result
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.catch(() => Effect.succeed({ diagnostics: {}, failed: ["diagnostic timeout"] })),
        ),
      ),
      changed: Effect.fn("LSP.changed")((file) =>
        Effect.gen(function* () {
          const result: Result = { diagnostics: {}, failed: [] }
          if (!FSUtil.contains(location.directory, file) && !FSUtil.contains(location.project.directory, file))
            return result
          for (const [name, server] of Object.entries(servers)) {
            if (server.extensions?.length && !server.extensions.includes(path.extname(file))) continue
            const root = yield* Effect.tryPromise(() => server.root(file, context)).pipe(
              Effect.catch(() => {
                result.failed.push(name)
                return Effect.succeed(undefined)
              }),
            )
            if (!root) continue
            const key = new ClientKey({ name, root })
            const update = yield* ScopedCache.get(clients, key).pipe(
              Effect.flatMap((client) =>
                !client
                  ? ScopedCache.invalidate(clients, key).pipe(Effect.as(undefined))
                  : Effect.tryPromise(async () => {
                      const after = Date.now()
                      const version = await client.notify.open({ path: file })
                      await client.waitForDiagnostics({ path: file, version, after, mode: "document" })
                      return client.diagnostics
                    }),
              ),
              Effect.map((diagnostics) => {
                if (!diagnostics) return true
                for (const [file, issues] of diagnostics)
                  result.diagnostics[file] = [...(result.diagnostics[file] ?? []), ...issues]
                return true
              }),
              Effect.catch(() => ScopedCache.invalidate(clients, key).pipe(Effect.as(false))),
              Effect.onInterrupt(() => ScopedCache.invalidate(clients, key)),
              locks.withLock(JSON.stringify([name, root])),
            )
            if (!update) result.failed.push(name)
          }
          return result
        }).pipe(
          Effect.timeout("20 seconds"),
          Effect.catch(() => Effect.succeed({ diagnostics: {}, failed: ["diagnostic timeout"] })),
        ),
      ),
    })
  }),
)

export const locationLayer = layer
export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Location.node, FSUtil.node, AppProcess.node, EventV2.node],
})
