import { expect, test } from "bun:test"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { serialize } from "node:v8"
import { Effect, ManagedRuntime } from "effect"
import { Catalog } from "@zaovra-ai/core/catalog"
import { Location } from "@zaovra-ai/core/location"
import { LocationServiceMap } from "@zaovra-ai/core/location-services"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { createMemoryAuthority } from "../../../../script/evaluation/memory/memory-authority"
import { startEvaluationRelay } from "../../../../script/evaluation/memory/relay"
import { createMemoryHost } from "../../script/evaluation/memory-host"
import { createLayer } from "../../script/evaluation/runtime-idle"
import { tmpdir } from "../fixture/fixture"

for (const family of ["gpt", "deepseek"] as const)
  test(`C authorizes actual Catalog projection for current ${family} configuration`, async () => {
    await using tmp = await tmpdir()
    const modelID = family === "gpt" ? "gpt-5.6-terra" : "deepseek-v4.1-flash-1017"
    const providerID = `evaluation-${family}`
    // No generation is needed: test the real Catalog/owned-relay handshake itself.
    const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 500 }) })
    const relay = startEvaluationRelay({
      baseURL: `http://127.0.0.1:${provider.port}/v1`,
      apiKey: "fixture-only",
      model: modelID,
      protocol: family === "gpt" ? "openai-responses" : "openai-chat",
      journal: path.join(tmp.path, "relay.jsonl"),
      maxRequests: 1,
      maxRequestBytes: 131072,
      maxOutput: 4096,
    })
    const authority = createMemoryAuthority({
      relay,
      baseURL: relay.baseURL,
      relayKey: relay.apiKey,
      modelID,
      providerID,
      protocol: family === "gpt" ? "openai-responses" : "openai-chat",
    })
    try {
      await Bun.write(
        path.join(tmp.path, "zaovra.json"),
        JSON.stringify({
          memory: { enabled: true, taskSearch: true, index: { enabled: true } },
          provider: {
            [providerID]: {
              npm: family === "gpt" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
              options: { baseURL: relay.baseURL, apiKey: relay.apiKey, timeout: 120000 },
              models: {
                [modelID]: {
                  family,
                  tool_call: true,
                  reasoning: true,
                  options: { maxTokens: 4096 },
                  limit: { context: 32000, output: 4096 },
                },
              },
            },
          },
        }),
      )
      const generation = randomUUID()
      await using stage = authority.openStage(generation, tmp.path)
      const experiment = createMemoryHost(stage.environment, generation)
      const runtime = ManagedRuntime.make(createLayer(experiment.host))
      try {
        await runtime.runPromise(experiment.initialize)
        const projected = await runtime.runPromise(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            return yield* Effect.gen(function* () {
              const catalog = yield* Catalog.Service
              const model = yield* catalog.model.get(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID))
              expect(model).toBeDefined()
              expect(model!.capabilities.memoryNote).toBe(true)
              return model!
            }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }))))
          }),
        )
        const changes = [
          { ...projected, id: ModelV2.ID.make("different-model") },
          { ...projected, api: { ...projected.api, url: "http://127.0.0.1:1/v1" } },
          { ...projected, request: { ...projected.request, variant: "changed" } },
          { ...projected, capabilities: { ...projected.capabilities, tools: false } },
          {
            ...projected,
            request: {
              ...projected.request,
              headers: { ...projected.request.headers, Authorization: "Bearer changed" },
              body: { ...projected.request.body, apiKey: "changed" },
            },
          },
          {
            ...projected,
            request: { ...projected.request, body: { ...projected.request.body, maxTokens: 8192, max_tokens: 8192 } },
          },
        ]
        for (const model of changes) {
          const generation = randomUUID()
          await using changed = authority.openStage(generation, tmp.path)
          const capability = JSON.parse(changed.environment) as { url: string; key: string }
          const response = await fetch(capability.url, {
            method: "POST",
            headers: { authorization: `Bearer ${capability.key}`, "content-type": "application/json" },
            body: JSON.stringify({ generation, snapshot: serialize(model).toString("base64") }),
          })
          expect(response.status).toBe(403)
          expect(await response.text()).toBe("")
          // Even a corrected snapshot cannot replay a consumed generation.
          expect(
            (
              await fetch(capability.url, {
                method: "POST",
                headers: { authorization: `Bearer ${capability.key}`, "content-type": "application/json" },
                body: JSON.stringify({ generation, snapshot: serialize(projected).toString("base64") }),
              })
            ).status,
          ).toBe(403)
        }
        expect(() =>
          createMemoryAuthority({
            relay: { ...relay },
            baseURL: relay.baseURL,
            relayKey: relay.apiKey,
            modelID,
            providerID,
            protocol: family === "gpt" ? "openai-responses" : "openai-chat",
          }),
        ).toThrow("evaluation-relay-not-owned")
        experiment.revoke()
        await runtime.runPromise(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            yield* Effect.gen(function* () {
              const catalog = yield* Catalog.Service
              expect(
                (yield* catalog.model.get(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)))!.capabilities
                  .memoryNote,
              ).toBeUndefined()
            }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }))))
          }),
        )
        authority.revoke()
        expect(() => authority.openStage(randomUUID(), tmp.path)).toThrow("evaluation-memory-authority-revoked")
        expect((await Bun.file(path.join(tmp.path, "relay.jsonl")).text()).includes('"phase":"admitted"')).toBe(false)
      } finally {
        experiment.revoke()
        await runtime.dispose()
      }
    } finally {
      authority.revoke()
      await relay.stop()
      await provider.stop(true)
    }
  }, 45000)
