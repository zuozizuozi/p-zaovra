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
