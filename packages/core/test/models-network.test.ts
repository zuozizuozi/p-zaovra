import { expect, test } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { ModelsDev } from "../src/models-dev"
import { Flag } from "../src/flag/flag"
import { Global } from "../src/global"
import { join } from "node:path"
import { readFile, writeFile, rm } from "node:fs/promises"

test("saved opt-out precedes startup; enabling starts refresh; disabling interrupts it and survives reload", async () => {
  const file = join(Global.Path.config, "models-network.json")
  const original = await readFile(file).catch(() => undefined)
  const disabled = Flag.ZAOVRA_DISABLE_MODELS_FETCH
  const source = Flag.ZAOVRA_MODELS_URL
  Flag.ZAOVRA_DISABLE_MODELS_FETCH = false
  Flag.ZAOVRA_MODELS_URL = "https://catalog.fixture.invalid"
  await writeFile(file, JSON.stringify({ autoRefresh: false }))
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const requested = yield* Deferred.make<void>()
          const aborted = yield* Deferred.make<void>()
          let calls = 0
          const transport = HttpClient.make(() =>
            Effect.gen(function* () {
              calls++
              yield* Deferred.succeed(requested, undefined)
              return yield* Effect.never.pipe(Effect.ensuring(Deferred.succeed(aborted, undefined)))
            }),
          )
          const layer = Layer.fresh(
            AppNodeBuilder.build(ModelsDev.node, [
              [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, transport)],
            ]),
          )
          yield* Effect.gen(function* () {
            const models = yield* ModelsDev.Service
            expect((yield* models.network()).autoRefresh).toBe(false)
            yield* models.refresh(true)
            expect(calls).toBe(0)
            yield* models.setAutoRefresh(true)
            yield* Deferred.await(requested)
            yield* models.setAutoRefresh(false)
            yield* Deferred.await(aborted)
            yield* models.refresh(true)
            expect(calls).toBe(1)
          }).pipe(Effect.provide(layer))
          yield* ModelsDev.Service.use((models) =>
            Effect.gen(function* () {
              expect((yield* models.network()).autoRefresh).toBe(false)
              yield* models.refresh(true)
              expect(calls).toBe(1)
            }),
          ).pipe(Effect.provide(Layer.fresh(layer)))
        }),
      ).pipe(Effect.timeout("5 seconds")),
    )
  } finally {
    Flag.ZAOVRA_DISABLE_MODELS_FETCH = disabled
    Flag.ZAOVRA_MODELS_URL = source
    if (original) await writeFile(file, original)
    else await rm(file, { force: true })
  }
})
