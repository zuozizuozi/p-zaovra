import { describe, expect, test } from "bun:test"
import { EventV2 } from "@zaovra-ai/core/event"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { eventData } from "./global"

describe("global eventData", () => {
  test("uses the stable payload ID as the SSE cursor", () => {
    const id = EventV2.ID.create()
    const envelope = { directory: "/repo", payload: { id, type: "server.connected", properties: {} } }
    const event = eventData(envelope)

    expect(event.id).toBe(id)
    expect(JSON.parse(event.data)).toEqual(envelope)
  })

  test("assigns an ID before transporting GlobalBus-only events", () => {
    let observed: GlobalEvent | undefined
    GlobalBus.once("event", (event) => {
      observed = event
    })

    GlobalBus.emit("event", { directory: "/repo", payload: { type: "worktree.ready", properties: {} } })

    if (!observed) throw new Error("GlobalBus did not emit the event")
    expect(observed.payload.id).toBeString()
    expect(eventData(observed).id).toBe(observed.payload.id)
  })

  test("replays events after a known Last-Event-ID cursor", () => {
    const first = {
      directory: "/repo",
      payload: { id: EventV2.ID.create(), type: "worktree.ready", properties: { order: 1 } },
    }
    const second = {
      directory: "/repo",
      payload: { id: EventV2.ID.create(), type: "worktree.ready", properties: { order: 2 } },
    }
    GlobalBus.emit("event", first)
    GlobalBus.emit("event", second)

    const replay = GlobalBus.replayAfter(first.payload.id)

    expect(replay.complete).toBe(true)
    expect(replay.events).toContain(second)
  })

  test("marks an unknown cursor as requiring a state reset", () => {
    expect(GlobalBus.replayAfter("evt_missing")).toEqual({ events: [], complete: false })
  })
})
