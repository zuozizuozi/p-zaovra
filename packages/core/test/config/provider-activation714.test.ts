import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { parse } from "jsonc-parser"
import { Config } from "@zaovra-ai/core/config"
import { ConfigProviderPlugin } from "@zaovra-ai/core/config/plugin/provider"
import { Catalog } from "@zaovra-ai/core/catalog"
import { Integration } from "@zaovra-ai/core/integration"
import { EventV2 } from "@zaovra-ai/core/event"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Global } from "@zaovra-ai/core/global"
import { Location } from "@zaovra-ai/core/location"
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
  name: "Old legacy gateway",
  npm: "@ai-sdk/openai-compatible",
  options: { baseURL: "https://gateway.example.invalid/v1", headers: { "x-old": "legacy" } },
  blacklist: ["gpt-4o-mini"],
  models: { existing: { name: "Old configured model" } },
}
const cases = [
  { name: "225 minimal native override without a default or agent", legacy, selected: undefined },
  { name: "minimal native override with the same selected model", legacy, selected: "gpt-4o" },
  { name: "changed selection appends only native model and does not restore legacy", legacy, selected: "gpt-agent" },
  {
    name: "legacy empty allowlist must not leak into minimal native override",
    legacy: { ...legacy, whitelist: [] },
    selected: undefined,
  },
  {
    name: "legacy disabled model must not leak into minimal native override",
    legacy: { ...legacy, models: { "gpt-4o": { status: "deprecated" }, existing: { name: "Old configured model" } } },
    selected: "gpt-4o",
  },
  {
    name: "explicit native empty allowlist stays authoritative",
    legacy,
    selected: "gpt-4o",
    nativeFilter: { allow: [] },
  },
  {
    name: "different-ID mixed configuration still appends into target legacy schema",
    legacy,
    selected: "gpt-4o",
    targetLegacy: true,
  },
] as const

describe("714 native override activation", () => {
  for (const item of cases)
    it.live(item.name, () =>
      Effect.acquireUseRelease(
        Effect.promise(tmpdir),
        (tmp) =>
          Effect.gen(function* () {
            const file = path.join(tmp.path, "zaovra.jsonc")
            const projectFile = path.join(tmp.path, "project", "zaovra.jsonc")
            const input = {
              ...(item.selected ? { model: "openai/" + item.selected } : {}),
              provider: { openai: item.legacy },
              providers:
                "targetLegacy" in item
                  ? { unrelated: { name: "Unrelated native" } }
                  : {
                      openai: {
                        models: { "gpt-4o": {} },
                        ...("nativeFilter" in item ? { filter: item.nativeFilter } : {}),
                      },
                    },
            }
            const contents =
              "// retain legal native override\n" +
              JSON.stringify(input, null, 2).replace('"gpt-4o": {}', '"gpt-4o": {/* keep native comment */}')
            const project = '// retain project restriction\n{"providers":{"openai":{"models":{"gpt-4o-mini":{}}}}}'
            yield* Effect.promise(() => Bun.write(file, contents))
            yield* Effect.promise(() => Bun.write(projectFile, project))
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
                            ["gpt-4o", "gpt-4o-mini", "gpt-agent", "existing"].map((id) => [
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
              yield* integration.connection.key({ integrationID: Integration.ID.make("openai"), key: "synthetic-714" })
              yield* ConfigProviderPlugin.Plugin.effect(ctx)
              const provider = yield* catalog.provider.get(ProviderV2.ID.make("openai"))
              const saved = yield* Effect.promise(() => Bun.file(file).text())
              const decoded = parse(saved)
              expect(decoded.provider).toEqual(
                "targetLegacy" in item
                  ? {
                      openai: { ...item.legacy, models: { ...item.legacy.models, "gpt-4o": {} } },
                    }
                  : input.provider,
              )
              expect(provider?.api).toMatchObject({
                type: "aisdk",
                package: "targetLegacy" in item ? "@ai-sdk/openai-compatible" : "@ai-sdk/openai",
                url: "targetLegacy" in item ? legacy.options.baseURL : "https://api.openai.com/v1",
              })
              expect(provider?.request.headers["x-old"]).toBe("targetLegacy" in item ? "legacy" : undefined)
              const available = (yield* catalog.model.available()).map((model) => String(model.id))
              expect(available.includes("gpt-4o")).toBe(!("nativeFilter" in item))
              expect(available.includes("gpt-4o-mini")).toBe(!("nativeFilter" in item || "targetLegacy" in item))
              expect(available.includes("existing")).toBe("targetLegacy" in item)
              expect(available.includes("gpt-agent")).toBe(item.selected === "gpt-agent")
              if (!("targetLegacy" in item)) {
                expect(Object.keys(decoded.providers.openai).sort()).toEqual(
                  "nativeFilter" in item ? ["filter", "models"] : ["models"],
                )
                expect(Config.latest(yield* config.entries(), "providers")?.openai.api).toBeUndefined()
                if (item.selected === "gpt-agent") {
                  expect(decoded.providers.openai.models["gpt-agent"]).toEqual({})
                  expect(saved).toContain("/* keep native comment */")
                } else {
                  expect(saved).toBe(contents)
                }
              }
              if ("targetLegacy" in item) {
                expect(decoded.provider.openai.models["gpt-4o"]).toEqual({})
                expect(decoded.providers).toEqual(input.providers)
              }
              expect(yield* Effect.promise(() => Bun.file(projectFile).text())).toBe(project)
              expect(saved).toContain("// retain legal native override")
              expect(saved).not.toContain("synthetic-714")
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
                        Location.Service.of(location({ directory: AbsolutePath.make(path.dirname(projectFile)) })),
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
})
