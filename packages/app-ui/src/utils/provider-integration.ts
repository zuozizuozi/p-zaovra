import type { IntegrationInfo, IntegrationMethod, ZaovraClient } from "@zaovra-ai/sdk/v2"
import { primaryProviderModel } from "../context/model-choice"

// A disposed form or a newer submission must not admit the old preparation's writes.
export function providerOperation() {
  const state = { generation: 0 }
  return {
    start: () => {
      const generation = ++state.generation
      return () => generation === state.generation
    },
    cancel: () => ++state.generation,
  }
}

export async function connectProviderKey(input: {
  client: ZaovraClient
  request: Parameters<ZaovraClient["v2"]["integration"]["connect"]["key"]>[0]
  current: () => boolean
  discover?: () => Promise<{ id: string; name: string }[]>
  models?: { id: string; name: string }[]
  saveModels?: (models: { id: string; name: string }[]) => Promise<unknown>
  enable?: () => Promise<unknown>
}) {
  if (!input.current()) return false
  const models = input.discover ? await input.discover() : input.models
  if (!input.current()) return false
  if (!models || !primaryProviderModel(models) || !input.saveModels) throw new Error("providerModelsRequired")
  await input.saveModels(models)
  if (!input.current()) return false
  // A dispatched credential write cannot be cancelled by closing its form.
  await input.client.v2.integration.connect.key(input.request, { throwOnError: true })
  if (!input.current()) return false
  await input.enable?.().catch(() => {
    throw new Error("providerReenableFailed")
  })
  return input.current()
}

export function reconnectDisabledProviders(disabled: readonly string[], providerID: string, enable: boolean) {
  return enable ? disabled.filter((id) => id !== providerID) : [...disabled]
}

export function providerConnectionMethods(integrationID: string, methods: readonly IntegrationMethod[] = []) {
  // Also protect a desktop connected to an older server that still advertises ChatGPT subscription login.
  return methods.filter(
    (method): method is Extract<IntegrationMethod, { type: "key" | "oauth" }> =>
      method.type === "key" || (method.type === "oauth" && integrationID !== "openai"),
  )
}

export function integrationLocation(directory?: string) {
  return directory ? { directory } : undefined
}

export async function resolveProviderIntegration(client: ZaovraClient, providerID: string, directory?: string) {
  const location = integrationLocation(directory)
  const provider = await client.v2.provider
    .get({ providerID, location }, { throwOnError: true })
    .then((response) => response.data.data)
  const integrationID = provider?.integrationID ?? providerID
  const integration = await client.v2.integration
    .get({ integrationID, location }, { throwOnError: true })
    .then((response) => response.data.data)
  return { integrationID, integration, location }
}

export function credentialConnectionIDs(integration: IntegrationInfo | null | undefined) {
  return (
    integration?.connections.flatMap((connection) => (connection.type === "credential" ? [connection.id] : [])) ?? []
  )
}

export async function disconnectProviderCredentials(client: ZaovraClient, providerID: string, directory?: string) {
  const resolved = await resolveProviderIntegration(client, providerID, directory)
  await Promise.all(
    credentialConnectionIDs(resolved.integration).map((credentialID) =>
      client.v2.credential.remove({ credentialID, location: resolved.location }, { throwOnError: true }),
    ),
  )
  return resolved
}
