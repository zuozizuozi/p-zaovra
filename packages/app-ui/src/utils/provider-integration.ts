import type { IntegrationInfo, ZaovraClient } from "@zaovra-ai/sdk/v2"

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
  return integration?.connections.flatMap((connection) => (connection.type === "credential" ? [connection.id] : [])) ?? []
}

export async function disconnectProviderCredentials(client: ZaovraClient, providerID: string, directory?: string) {
  const resolved = await resolveProviderIntegration(client, providerID, directory)
  await Promise.all(
    credentialConnectionIDs(resolved.integration).map((credentialID) =>
      client.v2.credential.remove(
        { credentialID, location: resolved.location },
        { throwOnError: true },
      ),
    ),
  )
  return resolved
}
