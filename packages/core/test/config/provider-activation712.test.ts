import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { parse } from "jsonc-parser"
import { Config } from "@zaovra-ai/core/config"
import { ConfigProviderPlugin } from "@zaovra-ai/core/config/plugin/provider"
import { Catalog } from "@zaovra-ai/core/catalog"
import { Integration } from "@zaovra-ai/core/integration"
import { EventV2 } from "@zaovra-ai/core/event"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Global } from "@zaovra-ai/core/global"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { Location } from "@zaovra-ai/core/location"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ModelsDev } from "@zaovra-ai/core/models-dev"
import { ModelsDevPlugin } from "@zaovra-ai/core/plugin/models-dev"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { catalogHost, host, integrationHost } from "../plugin/host"

const it = testEffect(Layer.empty)
const legacy = {
  name: "Legacy gateway",
  npm: "@ai-sdk/openai-compatible",
  options: { baseURL: "https://gateway.example.invalid/v1", headers: { "x-gateway": "preserved" } },
  blacklist: ["gpt-4o-mini"],
  models: { existing: { name: "Existing model" } },
}
const native = {
  name: "Native gateway",
  api: { type: "aisdk", package: "@ai-sdk/openai-compatible", settings: {}, url: "https://native.example.invalid/v1" },
  request: { headers: { "x-gateway": "native" } },
  filter: { deny: ["gpt-4o-mini"] },
  models: { existing: { name: "Native existing" } },
}
const cases = [
  {
    name: "pure V1",
    raw: { provider: { openai: legacy } },
    key: "provider",
    url: legacy.options.baseURL,
    header: "preserved",
  },
  { name: "pure V2", raw: { providers: { openai: native } }, key: "providers", url: native.api.url, header: "native" },
  {
    name: "mixed different IDs",
    raw: { provider: { openai: legacy }, providers: { unrelated: { name: "Other" } } },
    key: "provider",
    url: legacy.options.baseURL,
    header: "preserved",
  },
  {
    name: "mixed same ID keeps explicit native precedence",
    raw: { provider: { openai: legacy }, providers: { openai: native } },
    key: "providers",
    url: native.api.url,
    header: "native",
  },
  {
    name: "cross-layer blacklist",
    raw: { provider: { openai: legacy }, providers: { unrelated: {} } },
    project: { providers: { openai: { models: { "gpt-4o-mini": {} } } } },
    key: "provider",
    url: legacy.options.baseURL,
    header: "preserved",
  },
  {
    name: "global default and directory agent are independently persisted",
    raw: { provider: { openai: legacy }, providers: { unrelated: {} } },
    project: { agents: { build: { model: "openai/gpt-agent" } } },
    agent: true,
    key: "provider",
    url: legacy.options.baseURL,
    header: "preserved",
  },
  {
    name: "legacy explicit empty allowlist",
    raw: { provider: { openai: { ...legacy, whitelist: [] } }, providers: { unrelated: {} } },
    blocked: true,
    key: "provider",
    url: legacy.options.baseURL,
    header: "preserved",
  },
  {
    name: "selected native model stays disabled",
    raw: { providers: { openai: { ...native, models: { "gpt-4o": { disabled: true } } } } },
    blocked: true,
    key: "providers",
    url: native.api.url,
    header: "native",
  },
  {
    name: "cross-layer provider allow none",
    raw: { provider: { openai: legacy }, providers: { unrelated: {} } },
    project: { provider_filter: { allow: [] } },
    blocked: true,
    key: "provider",
    url: legacy.options.baseURL,
    header: "preserved",
  },
  {
    name: "cross-layer provider disabled",
    raw: { provider: { openai: legacy }, providers: { unrelated: {} } },
    project: { providers: { openai: { disabled: true } } },
    blocked: true,
    key: "provider",
    url: legacy.options.baseURL,
    header: "preserved",
  },
  {
    name: "cross-layer model deny",
    raw: { provider: { openai: legacy }, providers: { unrelated: {} } },
    project: { providers: { openai: { filter: { deny: ["gpt-4o"] } } } },
    blocked: true,
    key: "provider",
    url: legacy.options.baseURL,
    header: "preserved",
  },
] as const

describe("712 mixed-schema selected model activation", () => {
  for (const item of cases)
    it.live(item.name, () =>
      Effect.acquireUseRelease(
        Effect.promise(tmpdir),
        (tmp) =>
          Effect.gen(function* () {
            const file = path.join(tmp.path, "zaovra.jsonc")
            const project = path.join(tmp.path, "project")
            const contents =
              "// preserve JSONC gateway comment\n" +
              JSON.stringify({ model: "openai/gpt-4o", ...item.raw }, null, 2).replace(
                '"gpt-4o": {}',
                '"gpt-4o": {/* keep selected comment */}',
              )
            yield* Effect.promise(() => Bun.write(file, contents))
            if ("project" in item)
              yield* Effect.promise(() => Bun.write(path.join(project, "zaovra.json"), JSON.stringify(item.project)))
            const run = Effect.gen(function* () {
              const config = yield* Config.Service
              const catalog = yield* Catalog.Service
              const integration = yield* Integration.Service
              const ctx = host({ catalog: catalogHost(catalog), integration: integrationHost(integration) })
              yield* ModelsDevPlugin.effect(ctx).pipe(
                Effect.provideService(
                  ModelsDev.Service,
                  ModelsDev.Service.of({
                    get: () =>
                      Effect.succeed({
                        openai: {
                          id: "openai",
                          name: "OpenAI",
                          env: [],
                          npm: "@ai-sdk/openai",
                          api: "https://api.openai.com/v1",
                          models: Object.fromEntries(
                            ["gpt-4o", "gpt-4o-mini", "existing", "gpt-agent"].map((id) => [
                              id,
                              {
                                id,
                                name: id,
                                release_date: "2026-01-01",
                                attachment: false,
                                reasoning: false,
                                temperature: true,
                                tool_call: true,
                                cost: { input: 1, output: 1 },
                                limit: { context: 10000, output: 1000 },
                              },
                            ]),
                          ),
                        },
                      }),
                    refresh: () => Effect.void,
                    network: () => Effect.succeed({ autoRefresh: false, locked: true, source: "synthetic" }),
                    setAutoRefresh: () => Effect.void,
                  }),
                ),
              )
              yield* integration.connection.key({ integrationID: Integration.ID.make("openai"), key: "synthetic-712" })
              yield* ConfigProviderPlugin.Plugin.effect(ctx)
              const provider = yield* catalog.provider.get(ProviderV2.ID.make("openai"))
              expect(provider?.api).toMatchObject({
                type: "aisdk",
                package: "@ai-sdk/openai-compatible",
                url: item.url,
              })
              expect(provider?.request.headers["x-gateway"]).toBe(item.header)
              expect(provider?.name).toBe(item.header === "native" ? "Native gateway" : "Legacy gateway")
              const available = (yield* catalog.model.available()).map((model) => String(model.id))
              expect(available.includes("gpt-4o")).toBe(!("blocked" in item))
              expect(available).not.toContain("gpt-4o-mini")
              if ("agent" in item) {
                expect(available).toContain("gpt-agent")
                expect(
                  parse(yield* Effect.promise(() => Bun.file(path.join(project, "zaovra.json")).text())).providers
                    .openai.models["gpt-agent"],
                ).toEqual({})
              }
              if (
                "existing" in
                ("provider" in item.raw ? item.raw.provider.openai.models : item.raw.providers.openai.models)
              ) {
                expect(
                  (yield* catalog.model.get(ProviderV2.ID.make("openai"), ModelV2.ID.make("existing")))?.name,
                ).toBe(item.header === "native" ? "Native existing" : "Existing model")
              }
              expect((yield* catalog.model.default())?.id === "gpt-4o").toBe(!("blocked" in item))
              const saved = yield* Effect.promise(() => Bun.file(file).text())
              expect(saved.startsWith("// preserve JSONC gateway comment")).toBe(true)
              if (contents.includes("/* keep selected comment */"))
                expect(saved).toContain("/* keep selected comment */")
              expect(saved).not.toContain("synthetic-712")
              if (!("blocked" in item)) expect(parse(saved)[item.key].openai.models["gpt-4o"]).toBeDefined()
              // Reinitialize Config and Catalog, rather than reusing only an in-memory plan.
              return saved
            })
            const runAt = () =>
              run.pipe(
                Effect.provide(
                  AppNodeBuilder.build(LayerNode.group([Config.node, Catalog.node, Integration.node, EventV2.node]), [
                    [
                      Location.node,
                      Layer.succeed(
                        Location.Service,
                        Location.Service.of(
                          location({ directory: AbsolutePath.make("project" in item ? project : tmp.path) }),
                        ),
                      ),
                    ],
                    [Global.node, Global.layerWith({ config: tmp.path })],
                  ]),
                ),
              )
            const first = yield* runAt()
            expect(yield* runAt()).toBe(first)
            expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(first)
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )

  it.live("concurrent edit is adopted without overwriting or reporting selected model as configured", () =>
    Effect.acquireUseRelease(
      Effect.promise(tmpdir),
      (tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "zaovra.jsonc")
          yield* Effect.promise(() =>
            Bun.write(
              file,
              JSON.stringify({ model: "openai/gpt-4o", provider: { openai: legacy }, providers: { unrelated: {} } }),
            ),
          )
          yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const edited =
              "// newer edit\n" +
              JSON.stringify({ model: "openai/gpt-4o", provider: { openai: { ...legacy, whitelist: [] } } })
            yield* Effect.promise(() => Bun.write(file, edited))
            yield* config.activateModels!(["openai"])
            expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(edited)
            expect(Config.latest(yield* config.entries(), "providers")?.openai.filter?.allow).toEqual([])
            expect(Config.latest(yield* config.entries(), "providers")?.openai.models?.["gpt-4o"]).toBeUndefined()
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(Config.node, [
                [
                  Location.node,
                  Layer.succeed(
                    Location.Service,
                    Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                  ),
                ],
                [Global.node, Global.layerWith({ config: tmp.path })],
              ]),
            ),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.effect("general mixed same-ID decoder retains its whole-native-entry precedence", () =>
    Effect.sync(() => {
      const decoded = Option.getOrThrow(
        Config.decode({ provider: { openai: legacy }, providers: { openai: { name: "Explicit native override" } } }),
      )
      expect(decoded.providers?.openai.name).toBe("Explicit native override")
      expect(decoded.providers?.openai.api).toBeUndefined()
      expect(decoded.providers?.openai.models).toBeUndefined()
    }),
  )

  it.live("no saved credentials leave a subsequently edited file untouched", () =>
    Effect.acquireUseRelease(
      Effect.promise(tmpdir),
      (tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "zaovra.json")
          yield* Effect.promise(() => Bun.write(file, JSON.stringify({ model: "openai/gpt-4o" })))
          yield* Effect.gen(function* () {
            const config = yield* Config.Service
            yield* Effect.promise(() => Bun.write(file, "{ // unfinished concurrent edit"))
            yield* config.activateModels!([])
            expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("{ // unfinished concurrent edit")
            expect(Config.latest(yield* config.entries(), "providers")).toBeUndefined()
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(Config.node, [
                [
                  Location.node,
                  Layer.succeed(
                    Location.Service,
                    Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                  ),
                ],
                [Global.node, Global.layerWith({ config: tmp.path })],
              ]),
            ),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("failed migration write leaves disk and in-memory selection unconfigured", () =>
    Effect.acquireUseRelease(
      Effect.promise(tmpdir),
      (tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "zaovra.jsonc")
          const contents =
            "// retain failed-save original\n" +
            JSON.stringify({ model: "openai/gpt-4o", provider: { openai: legacy }, providers: { unrelated: {} } })
          yield* Effect.promise(() => Bun.write(file, contents))
          const fs = yield* FSUtil.Service
          yield* Effect.gen(function* () {
            const config = yield* Config.Service
            yield* config.activateModels!(["openai"])
            expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(contents)
            expect(Config.latest(yield* config.entries(), "providers")?.openai.models?.["gpt-4o"]).toBeUndefined()
            expect(Config.latest(yield* config.entries(), "providers")?.openai.api?.url).toBe(legacy.options.baseURL)
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(Config.node, [
                [
                  FSUtil.node,
                  Layer.succeed(
                    FSUtil.Service,
                    FSUtil.Service.of({
                      ...fs,
                      writeFileString: (target, text, options) =>
                        target === file
                          ? fs.writeFileString(path.join(tmp.path, "absent-directory", "config.json"), text, options)
                          : fs.writeFileString(target, text, options),
                    }),
                  ),
                ],
                [
                  Location.node,
                  Layer.succeed(
                    Location.Service,
                    Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                  ),
                ],
                [Global.node, Global.layerWith({ config: tmp.path })],
              ]),
            ),
          )
        }).pipe(Effect.provide(AppNodeBuilder.build(FSUtil.node))),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
