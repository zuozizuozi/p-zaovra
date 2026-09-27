import type { Event } from "@zaovra-ai/sdk/v2/client"
import { adaptPermissionRequest } from "./global-sync/utils"

// Normalize at the transport boundary so approval, notification and directory
// subscribers all observe the same UI contract, including events from replay.
export function adaptServerEvent(event: Event): Event {
  // SSE carries encoded DateTime values; projections use epoch milliseconds.
  // Normalize before optimistic messages and streaming timers enter UI state.
  if (
    event.type.startsWith("session.next.") &&
    "timestamp" in event.properties &&
    typeof event.properties.timestamp === "string"
  ) {
    const timestamp = Date.parse(event.properties.timestamp)
    if (Number.isFinite(timestamp)) event = { ...event, properties: { ...event.properties, timestamp } } as Event
  }
  switch (event.type) {
    case "permission.v2.asked":
      return { ...event, type: "permission.asked", properties: adaptPermissionRequest(event.properties) }
    case "permission.v2.replied":
      return { ...event, type: "permission.replied" }
    case "question.v2.asked":
      return { ...event, type: "question.asked" }
    case "question.v2.replied":
      return { ...event, type: "question.replied" }
    case "question.v2.rejected":
      return { ...event, type: "question.rejected" }
    default:
      return event
  }
}
