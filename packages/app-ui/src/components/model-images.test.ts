import { expect, test } from "bun:test"
import { imageInput, imageReference } from "./model-images"
import { protocolPatch } from "./provider-protocol"
import { providerModelsPatch } from "./provider-model-config"
import type { Config } from "@zaovra-ai/sdk/v2/types"

const provider = {
  npm: "@ai-sdk/openai",
  models: {
    exact: {
      modalities: { input: ["text", "audio", "pdf"], output: ["text", "image"] },
      variants: { deep: { reasoningEffort: "high" } },
    },
    missing: {},
  },
} satisfies NonNullable<Config["provider"]>[string]

test("825 untouched capability remains missing; explicit choices only change image input", () => {
  const original = structuredClone(provider)
  expect(imageInput(provider.models.exact, undefined)).toBeUndefined()
  expect(imageInput(provider.models.missing, undefined)).toBeUndefined()
  expect(imageInput(provider.models.exact, true)).toEqual(["text", "audio", "pdf", "image"])
  expect(imageInput({ modalities: { input: ["text", "audio", "pdf", "image"] } }, false)).toEqual([
    "text",
    "audio",
    "pdf",
  ])
  expect(imageInput(provider.models.missing, false)).toEqual(["text"])
  expect(provider).toEqual(original)
})

test("825 edited protocol stores only intentional image choices and preserves unrelated fields", () => {
  expect(protocolPatch(provider, "responses", {})).toEqual({})
  expect(protocolPatch(provider, "responses", {}, { missing: false })).toEqual({
    models: { missing: { modalities: { input: ["text"] } } },
  })
  expect(protocolPatch(provider, "responses", {}, { exact: true })).toEqual({
    models: { exact: { modalities: { input: ["text", "audio", "pdf", "image"] } } },
  })
  expect(provider.models.exact.modalities.output).toEqual(["text", "image"])
  expect(provider.models.exact.variants).toEqual({ deep: { reasoningEffort: "high" } })
})

test("825 saved-service additions and edits preserve modalities, choices and references", () => {
  const models = [
    { id: "exact", name: "Exact" },
    { id: "missing", name: "Missing" },
    { id: "new", name: "New" },
  ]
  const unchanged = providerModelsPatch("route", models, provider)
  expect(unchanged.provider.route.models.missing).not.toHaveProperty("modalities")
  expect(unchanged.provider.route.models.exact).toEqual({ name: "Exact", ...provider.models.exact })
  const enabled = providerModelsPatch("route", models, provider, undefined, { exact: true, new: false })
  expect(enabled.provider.route.models.exact.modalities).toEqual({
    input: ["text", "audio", "pdf", "image"],
    output: ["text", "image"],
  })
  expect(enabled.provider.route.models.exact.variants).toEqual(provider.models.exact.variants)
  expect(enabled.provider.route.models.new.modalities?.input).toEqual(["text"])
  const disabled = providerModelsPatch("route", models, enabled.provider.route, undefined, { exact: false })
  expect(disabled.provider.route.models.exact.modalities).toEqual(provider.models.exact.modalities)
  expect(disabled.provider.route.npm).toBe(provider.npm)
})

test("825 catalog hints require an exact ID and exclude custom declarations; they never enable images", () => {
  const catalog = [
    {
      id: "known",
      name: "Known catalog",
      models: { exact: { id: "exact", capabilities: { input: { image: true } } } },
    },
    { id: "custom", name: "Custom", models: { alias: { id: "alias", capabilities: { input: { image: true } } } } },
  ] as const
  expect(imageReference("exact", catalog, { custom: {} })).toBe("Known catalog")
  expect(imageReference("EXACT", catalog)).toBeUndefined()
  expect(imageReference("prefix-exact", catalog)).toBeUndefined()
  expect(imageReference("alias", catalog, { custom: {} })).toBeUndefined()
  expect(imageReference("exact", catalog, { known: {} })).toBeUndefined()
  expect(imageInput(undefined, undefined)).toBeUndefined()
})
