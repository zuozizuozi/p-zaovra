import type { Provider } from "@zaovra-ai/sdk/v2/client"

// This comparison is process-local and is never logged or persisted. A key edit
// creates a new credential identity; config edits invalidate earlier successes.
export function providerVerificationToken(provider: Provider | undefined, config: unknown) {
  if (!provider) return ""
  return JSON.stringify([provider.options.connectionIDs ?? [], config ?? null])
}

export function providerRequestSucceeded(
  message: {
    role: string
    error?: unknown
    finish?: string
    time: { created: number; completed?: number }
  },
  since: number,
) {
  return (
    message.role === "assistant" &&
    !message.error &&
    message.time.created >= since &&
    message.time.completed !== undefined &&
    message.finish !== undefined &&
    !["error", "unknown"].includes(message.finish)
  )
}

export function createProviderVerification(token: (providerID: string) => string, since = Date.now()) {
  const requests = new Map<string, { providerID: string; token: string }>()
  return (message: Parameters<typeof providerRequestSucceeded>[0] & { id: string; providerID: string }) => {
    if (message.role !== "assistant" || message.time.created < since) return
    if (message.time.completed === undefined) {
      if (!requests.has(message.id))
        requests.set(message.id, { providerID: message.providerID, token: token(message.providerID) })
      return
    }
    const request = requests.get(message.id)
    requests.delete(message.id)
    if (
      !request ||
      request.providerID !== message.providerID ||
      !request.token ||
      request.token !== token(message.providerID)
    )
      return
    if (message.error) return { providerID: message.providerID, token: "" }
    if (providerRequestSucceeded(message, since)) return { providerID: message.providerID, token: request.token }
  }
}
