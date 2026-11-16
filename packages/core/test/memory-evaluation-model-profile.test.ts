import { expect, test } from "bun:test"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { createEvaluationMemoryProfile } from "../../../script/evaluation/memory/model-profile"

function fixture() {
  return ModelV2.Info.make({
    ...ModelV2.Info.empty(ProviderV2.ID.make("evaluation-offline"), ModelV2.ID.make("offline-alias")),
    api: {
      id: ModelV2.ID.make("offline-wire-model"),
      type: "aisdk",
      package: "@ai-sdk/openai-compatible",
      url: "http://127.0.0.1:41234/v1",
      settings: { apiKey: "synthetic-local-capability" },
    },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: { "x-fixture": "one" }, body: { maxTokens: 4096 }, variant: "low" },
    variants: [
      { id: ModelV2.VariantID.make("low"), headers: {}, body: { reasoning_effort: "low" } },
      { id: ModelV2.VariantID.make("high"), headers: {}, body: { reasoning_effort: "high" } },
    ],
    limit: { context: 32000, output: 4096 },
  })
}

const binding = {
  baseURL: "http://127.0.0.1:41234/v1",
  modelID: "offline-wire-model",
  protocol: "openai-chat" as const,
}

test("matches effective variant and projected capability without granting another variant", () => {
  const model = fixture()
  const grant = createEvaluationMemoryProfile({ model, variant: "low", binding })
  expect(grant.profile.memoryNote(model, "low")).toBe(true)
  expect(grant.profile.memoryNote({ ...model, capabilities: { ...model.capabilities, memoryNote: true } }, "low")).toBe(
    true,
  )
  expect(grant.profile.memoryNote({ ...model, name: "display-only rename" }, "low")).toBe(true)
  for (const variant of [undefined, "default", "high", "missing"]) {
    expect(grant.profile.memoryNote(model, variant)).toBeUndefined()
  }
  grant.revoke()
  grant.revoke()
  expect(grant.profile.memoryNote(model, "low")).toBeUndefined()
})

test("same names cannot carry permission across endpoint, SDK, request, variant or capability edits", () => {
  const model = fixture()
  const grant = createEvaluationMemoryProfile({ model, variant: "low", binding })
  const changes: ModelV2.Info[] = [
    { ...model, id: ModelV2.ID.make("another-alias") },
    { ...model, providerID: ProviderV2.ID.make("another-provider") },
    { ...model, api: { ...model.api, id: ModelV2.ID.make("another-wire-model") } },
    { ...model, api: { ...model.api, url: "http://127.0.0.1:41235/v1" } },
    { ...model, api: { ...model.api, type: "aisdk", package: "@ai-sdk/openai" } },
    { ...model, api: { ...model.api, settings: { apiKey: "other-local-capability" } } },
    {
      ...model,
      api: {
        ...model.api,
        settings: { apiKey: "synthetic-local-capability", maxTokensParameter: "max_completion_tokens" },
      },
    },
    { ...model, request: { ...model.request, headers: { "x-fixture": "two" } } },
    { ...model, request: { ...model.request, body: { maxTokens: 2048 } } },
    { ...model, request: { ...model.request, variant: "high" } },
    { ...model, variants: model.variants.map((variant) => ({ ...variant, body: { reasoning_effort: "minimal" } })) },
    { ...model, variants: model.variants.map((variant) => ({ ...variant, headers: { "x-changed": "yes" } })) },
    { ...model, variants: model.variants.slice(0, 1) },
    { ...model, limit: { ...model.limit, output: 2048 } },
    { ...model, enabled: false },
    { ...model, memoryNote: "off" },
    { ...model, capabilities: { ...model.capabilities, tools: false } },
    { ...model, capabilities: { ...model.capabilities, interleavedThinking: true } },
  ]
  for (const changed of changes) expect(grant.profile.memoryNote(changed, "low")).toBeUndefined()
  expect(grant.profile.memoryNote(model, "low")).toBe(true)
})

test("private snapshot does not track mutations to the host's original object", () => {
  const mutable = structuredClone(fixture()) as ModelV2.MutableInfo
  const before = structuredClone(mutable)
  const grant = createEvaluationMemoryProfile({ model: mutable, variant: "low", binding })
  mutable.request.body.maxTokens = 1
  mutable.variants[0].body.reasoning_effort = "high"
  expect(grant.profile.memoryNote(mutable, "low")).toBeUndefined()
  expect(grant.profile.memoryNote(before, "low")).toBe(true)
  expect(JSON.stringify(grant)).not.toContain("synthetic-local-capability")
})

test("rejects inconsistent binding and missing or duplicate variants before creating a profile", () => {
  const model = fixture()
  for (const baseURL of [
    "https://example.test/v1",
    "http://localhost:41234/v1",
    "http://127.0.0.1/v1",
    "http://127.0.0.1:41234/v1?route=1",
  ]) {
    expect(() =>
      createEvaluationMemoryProfile({
        model: { ...model, api: { ...model.api, url: baseURL } },
        variant: "low",
        binding: { ...binding, baseURL },
      }),
    ).toThrow("invalid-evaluation-memory-profile")
  }
  expect(() => createEvaluationMemoryProfile({ model, variant: "missing", binding })).toThrow(
    "invalid-evaluation-memory-profile",
  )
  expect(() => createEvaluationMemoryProfile({ model, variant: undefined, binding })).toThrow(
    "invalid-evaluation-memory-profile",
  )
  expect(() =>
    createEvaluationMemoryProfile({
      model: { ...model, variants: [...model.variants, model.variants[0]] },
      variant: "low",
      binding,
    }),
  ).toThrow("invalid-evaluation-memory-profile")
  expect(() =>
    createEvaluationMemoryProfile({ model, variant: "low", binding: { ...binding, protocol: "openai-responses" } }),
  ).toThrow("invalid-evaluation-memory-profile")
  expect(() =>
    createEvaluationMemoryProfile({ model, variant: "low", binding: { ...binding, modelID: "another" } }),
  ).toThrow("invalid-evaluation-memory-profile")
  expect(() =>
    createEvaluationMemoryProfile({ model: { ...model, memoryNote: "off" }, variant: "low", binding }),
  ).toThrow("invalid-evaluation-memory-profile")
  expect(() => createEvaluationMemoryProfile({ model: { ...model, enabled: false }, variant: "low", binding })).toThrow(
    "invalid-evaluation-memory-profile",
  )
  expect(() =>
    createEvaluationMemoryProfile({
      model: { ...model, capabilities: { ...model.capabilities, tools: false } },
      variant: "low",
      binding,
    }),
  ).toThrow("invalid-evaluation-memory-profile")
})

test("undefined default is exact and independent hosts can revoke separately", () => {
  const base = fixture()
  const model = { ...base, request: { headers: base.request.headers, body: base.request.body }, variants: [] }
  const first = createEvaluationMemoryProfile({ model, variant: undefined, binding })
  const second = createEvaluationMemoryProfile({ model, variant: undefined, binding })
  expect(first.profile.memoryNote(model, undefined)).toBe(true)
  expect(first.profile.memoryNote(model, "default")).toBeUndefined()
  expect(
    first.profile.memoryNote({ ...model, request: { ...model.request, variant: "new-default" } }, undefined),
  ).toBeUndefined()
  first.revoke()
  expect(first.profile.memoryNote(model, undefined)).toBeUndefined()
  expect(second.profile.memoryNote(model, undefined)).toBe(true)
})

test("Responses has its own exact SDK binding and object key ordering is not a configuration change", () => {
  const base = fixture()
  const model = { ...base, api: { ...base.api, type: "aisdk" as const, package: "@ai-sdk/openai" } }
  const grant = createEvaluationMemoryProfile({
    model,
    variant: "low",
    binding: { ...binding, protocol: "openai-responses" },
  })
  expect(grant.profile.memoryNote(model, "low")).toBe(true)
  expect(
    grant.profile.memoryNote(
      { ...model, request: { variant: "low", body: { maxTokens: 4096 }, headers: { "x-fixture": "one" } } },
      "low",
    ),
  ).toBe(true)
  expect(grant.profile.memoryNote(base, "low")).toBeUndefined()
})

test("uncloneable plugin settings fail with a fixed diagnostic", () => {
  const model = fixture()
  expect(() =>
    createEvaluationMemoryProfile({
      model: { ...model, api: { ...model.api, settings: { callback: () => "synthetic-secret" } } },
      variant: "low",
      binding,
    }),
  ).toThrow(new Error("invalid-evaluation-memory-profile"))
})
