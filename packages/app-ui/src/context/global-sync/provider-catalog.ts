import type { IntegrationInfo, Model, ModelV2Info, Provider, ProviderV2Info } from "@zaovra-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@zaovra-ai/session-ui/context"

export function adaptProviderCatalog(
  providers: ProviderV2Info[],
  models: ModelV2Info[],
  integrations: IntegrationInfo[],
): NormalizedProviderListResponse {
  const all = new Map<string, Provider>(
    integrations.map((integration) => [
      integration.id,
      {
        id: integration.id,
        name: integration.name,
        source: integration.connections.some((connection) => connection.type === "env") ? "env" : "api",
        env: integration.methods.flatMap((method) => (method.type === "env" ? method.names : [])),
        options: { integrationID: integration.id },
        models: {},
      },
    ]),
  )
  providers
    .filter((provider) => !provider.disabled)
    .forEach((provider) => {
      const integration = integrations.find((item) => item.id === (provider.integrationID ?? provider.id))
      all.set(provider.id, {
        id: provider.id,
        name: provider.name,
        source: integration?.connections.some((connection) => connection.type === "env")
          ? "env"
          : integration?.connections.length
            ? "api"
            : "config",
        env: integration?.methods.flatMap((method) => (method.type === "env" ? method.names : [])) ?? [],
        options: { integrationID: provider.integrationID ?? provider.id },
        models: Object.fromEntries(
          models
            .filter((model) => model.providerID === provider.id && model.enabled && model.status !== "deprecated")
            .map((model) => [model.id, adaptModel(model)]),
        ),
      })
    })
  return {
    all,
    connected: providers.filter((provider) => !provider.disabled).map((provider) => provider.id),
    default: {},
  }
}

function adaptModel(model: ModelV2Info): Model {
  return {
    id: model.id,
    providerID: model.providerID,
    name: model.name,
    family: model.family,
    api: { id: model.api.id, url: model.api.url ?? "", npm: model.api.type === "aisdk" ? model.api.package : "" },
    capabilities: {
      temperature: false,
      reasoning: model.capabilities.output.includes("reasoning"),
      attachment: model.capabilities.input.some((type) => type !== "text"),
      toolcall: model.capabilities.tools,
      input: {
        text: model.capabilities.input.includes("text"),
        audio: model.capabilities.input.includes("audio"),
        image: model.capabilities.input.includes("image"),
        video: model.capabilities.input.includes("video"),
        pdf: model.capabilities.input.includes("pdf"),
      },
      output: {
        text: model.capabilities.output.includes("text"),
        audio: model.capabilities.output.includes("audio"),
        image: model.capabilities.output.includes("image"),
        video: model.capabilities.output.includes("video"),
        pdf: model.capabilities.output.includes("pdf"),
      },
      interleaved: false,
    },
    cost: {
      ...(model.cost.find((cost) => !cost.tier) ?? { input: 0, output: 0, cache: { read: 0, write: 0 } }),
      tiers: model.cost.flatMap((cost) => (cost.tier ? [{ ...cost, tier: cost.tier }] : [])),
    },
    limit: model.limit,
    status: model.status,
    options: model.request.body,
    headers: model.request.headers,
    release_date: model.time.released > 0 ? new Date(model.time.released).toISOString().slice(0, 10) : "",
    variants: Object.fromEntries(model.variants.map((variant) => [variant.id, variant.body])),
  }
}
