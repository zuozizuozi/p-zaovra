import { describe, expect, test } from "bun:test"
import { EventV2 } from "@zaovra-ai/core/event"
import { eventData } from "./event"

describe("eventData", () => {
  test("writes the business event ID to the SSE cursor", () => {
    const id = EventV2.ID.create()
    const event = eventData({ id, type: "server.connected", data: {} })

    expect(event.id).toBe(id)
    expect(JSON.parse(event.data)).toEqual({ id, type: "server.connected", data: {} })
  })
})
