import type { Session, ZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { toLegacySessionSummary } from "./global-sync/home-session-index"

export async function listV2Sessions(
  client: ZaovraClient,
  input: {
    directory?: string
    roots?: boolean
    search?: string
    limit?: number
    order?: "asc" | "desc"
  } = {},
  options?: { signal?: AbortSignal },
): Promise<{ data: Session[] }> {
  const response = await client.v2.session.list(input, options)
  return { data: (response.data?.data ?? []).map(toLegacySessionSummary) }
}
