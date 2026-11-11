import type { Config } from "@zaovra-ai/sdk/v2/types"

type Model = NonNullable<NonNullable<Config["provider"]>[string]["models"]>[string]

export function imageInput(model: Model | undefined, enabled: boolean | undefined) {
  if (enabled === undefined) return undefined
  const input: NonNullable<NonNullable<Model["modalities"]>["input"]> = model?.modalities?.input ?? ["text"]
  return enabled
    ? input.includes("image")
      ? input
      : [...input, "image" as const]
    : input.filter((item) => item !== "image")
}

export function imageReference(
  id: string,
  providers: Iterable<{
    id: string
    name: string
    models: Record<string, { id: string; capabilities: { input: { image: boolean } } }>
  }>,
  configured: Record<string, unknown> = {},
) {
  // Custom declarations are user choices, not independent catalog evidence.
  return Array.from(providers).find(
    (provider) =>
      !Object.hasOwn(configured, provider.id) &&
      Object.values(provider.models).some((model) => model.id === id && model.capabilities.input.image),
  )?.name
}
