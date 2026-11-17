import type { AssistantMessage, Part } from "@zaovra-ai/sdk/v2"
import { toolFailureDisposition } from "@zaovra-ai/session-ui/tool-recovery"

/** Placement only: an unrelated later command cannot excuse an earlier failure. */
export function processToolFailures(
  messages: readonly AssistantMessage[],
  parts: (id: string) => readonly Part[],
  _working: boolean,
) {
  return new Set(
    messages.flatMap((message) =>
      parts(message.id).flatMap((part) =>
        toolFailureDisposition(message, part)?.status === "exploratory" ? [part.id] : [],
      ),
    ),
  )
}
