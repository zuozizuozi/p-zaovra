import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config } from "@zaovra-ai/core/config"
import { ConfigProviderActivation } from "@zaovra-ai/core/config/provider-activation"
import { ConfigProviderPlugin } from "@zaovra-ai/core/config/plugin/provider"
import { Catalog } from "@zaovra-ai/core/catalog"
import { Integration } from "@zaovra-ai/core/integration"
import { EventV2 } from "@zaovra-ai/core/event"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Global } from "@zaovra-ai/core/global"
import { Location } from "@zaovra-ai/core/location"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { catalogHost, host, integrationHost } from "../plugin/host"

const it = testEffect(Layer.empty)
const document = (info: unknown) =>
  new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)(info) })

describe("707 selected model activation", () => {
  for (const info of [
    { provider_filter: { allow: [] } },
    { provider_filter: { deny: ["saved"] } },
    { providers: { saved: { disabled: true } } },
    { providers: { saved: { filter: { allow: [] } } } },
    { providers: { saved: { filter: { deny: ["chosen"] } } } },
    { providers: { saved: { models: { chosen: { disabled: true } } } } },
    { providers: { saved: { models: { chosen: {} } } } },
  ])
    it.effect("707 preserves explicit restriction " + JSON.stringify(info), () =>
      Effect.sync(() => {
        const entries = [document({ model: "saved/chosen" }), document(info)]
        expect(ConfigProviderActivation.plan(entries, ["saved"])).toEqual([])
      }),
    )

  it.effect("707 multi-layer partial model documents never undo disabled intent", () =>
    Effect.sync(() => {
      const entries = [
        document({ model: "saved/chosen", providers: { saved: { models: { chosen: { disabled: true } } } } }),
        document({ providers: { saved: { models: { chosen: { name: "renamed" } } } } }),
      ]
      expect(ConfigProviderActivation.plan(entries, ["saved"])).toEqual([])
      expect(ConfigProviderActivation.plan([document({ model: "saved/chosen" })], [])).toEqual([])
      expect(ConfigProviderActivation.plan([document({ model: "saved/auto:high" })], ["saved"])).toEqual([])
    }),
  )

  for (const legacy of [false, true])
    it.live("707 persists and executes only old keyed default / selected models; legacy=" + legacy, () =>
      Effect.acquireUseRelease(
        Effect.promise(tmpdir),
        (tmp) =>
          Effect.gen(function* () {
            const file = path.join(tmp.path, "zaovra.jsonc")
            const contents = `// keep this comment\n${JSON.stringify({ model: "saved/chosen", [legacy ? "agent" : "agents"]: { build: { model: "saved/other" } } }, null, 2)}`
            yield* Effect.promise(() => Bun.write(file, contents))
            const run = Effect.gen(function* () {
              const config = yield* Config.Service
              yield* config.activateModels!([])
              expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(contents)
              const catalog = yield* Catalog.Service
              const integrations = yield* Integration.Service
              yield* integrations.transform((draft) => {
                draft.update(Integration.ID.make("saved"), () => {})
                draft.method.update({ integrationID: Integration.ID.make("saved"), method: { type: "key" } })
              })
              yield* integrations.connection.key({ integrationID: Integration.ID.make("saved"), key: "synthetic-707" })
              yield* catalog.transform((draft) => {
                draft.provider.update(ProviderV2.ID.make("saved"), (provider) => {
                  provider.integrationID = Integration.ID.make("saved")
                })
                for (const id of ["chosen", "other", "unselected"])
                  draft.model.update(ProviderV2.ID.make("saved"), ModelV2.ID.make(id), (model) => {
                    model.enabled = false
                  })
              })
              yield* ConfigProviderPlugin.Plugin.effect(
                host({ catalog: catalogHost(catalog), integration: integrationHost(integrations) }),
              )
              expect((yield* catalog.model.available()).map((model) => String(model.id)).toSorted()).toEqual([
                "chosen",
                "other",
              ])
              const saved = yield* Effect.promise(() => Bun.file(file).text())
              expect(saved.startsWith("// keep this comment")).toBe(true)
              const entries = yield* config.entries()
              const configured = entries.filter((entry): entry is Config.Document => entry.type === "document")
              expect(Object.keys(configured[0].info.providers?.saved.models ?? {}).toSorted()).toEqual([
                "chosen",
                "other",
              ])
              yield* config.activateModels!(["saved"])
              expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(saved)
              // No key metadata is copied into configuration by the migration.
              expect(saved.includes("synthetic-707")).toBe(false)
            })
            yield* run.pipe(
              Effect.provide(
                AppNodeBuilder.build(LayerNode.group([Config.node, Catalog.node, Integration.node, EventV2.node]), [
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

  it.live("707 global and preloaded directory config adopt the same persisted migration", () =>
    Effect.acquireUseRelease(
      Effect.promise(tmpdir),
      (tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "zaovra.json")
          yield* Effect.promise(() => Bun.write(file, JSON.stringify({ model: "saved/chosen" })))
          const services = yield* Effect.forEach([tmp.path, path.join(tmp.path, "project")], (directory) =>
            Config.Service.pipe(
              Effect.provide(
                AppNodeBuilder.build(Config.node, [
                  [
                    Location.node,
                    Layer.succeed(
                      Location.Service,
                      Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
                    ),
                  ],
                  [Global.node, Global.layerWith({ config: tmp.path })],
                ]),
              ),
            ),
          )
          yield* services[0].activateModels!(["saved"])
          yield* services[1].activateModels!(["saved"])
          const global = Config.latest(yield* services[0].entries(), "providers")
          const directory = Config.latest(yield* services[1].entries(), "providers")
          expect(global?.saved.models).toEqual({ chosen: {} })
          expect(directory?.saved.models).toEqual(global?.saved.models)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
