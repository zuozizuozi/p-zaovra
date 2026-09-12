import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Catalog } from "@zaovra-ai/core/catalog"
import { Config } from "@zaovra-ai/core/config"
import { ConfigProviderPlugin } from "@zaovra-ai/core/config/plugin/provider"
import { Integration } from "@zaovra-ai/core/integration"
import { ModelV2 } from "@zaovra-ai/core/model"
import { PluginV2 } from "@zaovra-ai/core/plugin"
import { PluginHost } from "@zaovra-ai/core/plugin/host"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { ConfigMigrateV1 } from "@zaovra-ai/core/v1/config/migrate"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* (config: Config.Interface) {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, config))
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

function request(headers: Record<string, string>, variant?: string) {
  return {
    headers,
    variant,
  }
}

const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigProviderPlugin.Plugin", () => {
  ;[
    {
      name: "provider allowlist",
      configs: [{ enabled_providers: ["custom"] }],
      expected: ["custom/one", "custom/two", "custom/three"],
    },
    { name: "empty provider allowlist", configs: [{ enabled_providers: [] }], expected: [] },
    {
      name: "model allowlist and deny precedence",
      configs: [{ provider: { custom: { whitelist: ["one", "two"], blacklist: ["two"] } } }],
      expected: ["builtin/one", "custom/one"],
    },
    {
      name: "cleared provider and model deny lists",
      configs: [
        { disabled_providers: ["builtin"], provider: { custom: { blacklist: ["one"] } } },
        { disabled_providers: [], provider: { custom: { blacklist: [] } } },
      ],
      expected: ["builtin/one", "custom/one", "custom/two", "custom/three"],
    },
  ].forEach((test) =>
    it.effect(`preserves legacy ${test.name} in the executor catalog`, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        yield* catalog.transform((editor) => {
          editor.model.update(ProviderV2.ID.make("builtin"), ModelV2.ID.make("one"), () => {})
          for (const id of ["one", "two", "three"])
            editor.model.update(ProviderV2.ID.make("custom"), ModelV2.ID.make(id), () => {})
        })
        yield* addPlugin(
          Config.Service.of({
            entries: () =>
              Effect.succeed(
                test.configs.map(
                  (config) => new Config.Document({ type: "document", info: decode(ConfigMigrateV1.migrate(config)) }),
                ),
              ),
          }),
        )
        expect((yield* catalog.model.available()).map((model) => `${model.providerID}/${model.id}`)).toEqual(
          test.expected,
        )
      }),
    ),
  )

  it.effect("honors desktop provider disabling after V1 migration, including built-in providers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((editor) => {
        for (const id of ["disabled-built-in", "disabled-custom", "available"]) {
          editor.provider.update(ProviderV2.ID.make(id), () => {})
          editor.model.update(ProviderV2.ID.make(id), ModelV2.ID.make("chat"), () => {})
        }
      })
      yield* addPlugin(
        Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: decode(
                  ConfigMigrateV1.migrate({
                    disabled_providers: ["disabled-built-in", "disabled-custom"],
                    provider: { "disabled-custom": { name: "Custom" } },
                  }),
                ),
              }),
            ]),
        }),
      )
      expect((yield* catalog.provider.available()).map((provider) => String(provider.id))).toEqual(["available"])
      expect((yield* catalog.model.available()).map((model) => String(model.providerID))).toEqual(["available"])
      expect(required(yield* catalog.provider.get(ProviderV2.ID.make("disabled-custom"))).name).toBe("Custom")
    }),
  )

  it.effect("allows a later V2 provider configuration to re-enable a disabled provider", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* addPlugin(
        Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({ type: "document", info: decode({ providers: { custom: { disabled: true } } }) }),
              new Config.Document({ type: "document", info: decode({ providers: { custom: { disabled: false } } }) }),
            ]),
        }),
      )
      expect((yield* catalog.provider.available()).map((provider) => String(provider.id))).toEqual(["custom"])
    }),
  )

  it.effect("registers a key integration for a configured custom provider", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  custom: {
                    name: "Custom",
                    api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://example.test" },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      expect(yield* integrations.get(Integration.ID.make("custom"))).toMatchObject({
        id: "custom",
        name: "Custom",
        methods: [{ type: "key", label: "API key" }],
      })
    }),
  )

  it.effect("keeps configured model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.zaovra
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  zaovra: {
                    api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://zaovra.test/v1" },
                    models: {
                      "alpha-gpt-next": {
                        variants: [
                          {
                            id: "high",
                            body: {
                              reasoningEffort: "high",
                              reasoningSummary: "auto",
                              include: ["reasoning.encrypted_content"],
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants).toMatchObject([
        {
          id: "high",
          body: {
            reasoningEffort: "high",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        },
      ])
    }),
  )

  it.effect("keeps layered model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.zaovra
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  zaovra: {
                    api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://zaovra.test/v1" },
                  },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  zaovra: {
                    models: {
                      "alpha-gpt-next": {
                        variants: [{ id: "high", body: { reasoningEffort: "high" } }],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants[0]).toMatchObject({
        id: "high",
        body: { reasoningEffort: "high" },
      })
    }),
  )

  it.effect("loads configured providers and applies later model overrides", () =>
    withEnv({ CUSTOM_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const integrations = yield* Integration.Service
        const providerID = ProviderV2.ID.make("custom")
        const modelID = ModelV2.ID.make("chat")
        const config = Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: decode({
                  model: "custom/first",
                  providers: {
                    custom: {
                      name: "Configured",
                      env: ["CUSTOM_API_KEY"],
                      api: { type: "native", settings: {} },
                      request: request({ first: "first", shared: "first" }),
                      models: {
                        chat: {
                          name: "First",
                          capabilities: { tools: true, input: ["text"], output: ["text"] },
                          disabled: true,
                          limit: { context: 100, output: 50 },
                          cost: { input: 1, output: 2 },
                          request: request({ first: "first", shared: "first" }, "retained"),
                          variants: [
                            {
                              id: "fast",
                              headers: { first: "first", shared: "first" },
                            },
                          ],
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  model: "custom/default",
                  providers: {
                    custom: {
                      api: { type: "aisdk", package: "custom-sdk", url: "https://example.test" },
                      request: request({ last: "last", shared: "last" }),
                      models: {
                        default: {
                          name: "Default",
                        },
                        chat: {
                          api: { id: "api-chat" },
                          name: "Last",
                          limit: { output: 75 },
                          request: request({ last: "last", shared: "last" }),
                          variants: [
                            {
                              id: "fast",
                              headers: { last: "last", shared: "last" },
                            },
                            {
                              id: "slow",
                              headers: { slow: "slow" },
                            },
                          ],
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  providers: {
                    custom: { name: "Renamed" },
                  },
                }),
              }),
            ]),
        })

        yield* addPlugin(config)

        const provider = required(yield* catalog.provider.get(providerID))
        const model = required(yield* catalog.model.get(providerID, modelID))
        expect((yield* catalog.model.default())?.id).toBe(ModelV2.ID.make("default"))
        expect(provider.name).toBe("Renamed")
        expect((yield* integrations.get(Integration.ID.make("custom")))?.methods).toContainEqual({
          type: "env",
          names: ["CUSTOM_API_KEY"],
        })
        expect((yield* integrations.get(Integration.ID.make("custom")))?.name).toBe("Renamed")
        expect(provider.disabled).toBeUndefined()
        expect(provider.api).toEqual({ type: "aisdk", package: "custom-sdk", url: "https://example.test" })
        expect(provider.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.api.id).toBe(ModelV2.ID.make("api-chat"))
        expect(model.name).toBe("Last")
        expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
        expect(model.enabled).toBe(false)
        expect(model.limit).toEqual({ context: 100, output: 75 })
        expect(model.cost).toEqual([{ input: 1, output: 2, cache: { read: 0, write: 0 }, tier: undefined }])
        expect(model.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.request.variant).toBe("retained")
        expect(model.variants.map((variant) => variant.id)).toEqual([
          ModelV2.VariantID.make("fast"),
          ModelV2.VariantID.make("slow"),
        ])
        expect(model.variants[0]?.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.variants[1]?.headers).toEqual({ slow: "slow" })
      }),
    ),
  )
})
