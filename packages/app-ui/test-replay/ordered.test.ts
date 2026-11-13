// Request-level checks of the ordered feed's wiring: what happens when answers and events cross.
import { describe, expect, test } from "bun:test"
import type { ZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { DurableEventManifest } from "@zaovra-ai/schema/durable-event-manifest"
import { createKernel, type Wire } from "./kernel"
import { createServerSession } from "../src/context/server-session"

const sessionID = "ses_ordered"
const versions = new Map<string, string>(
  [...DurableEventManifest.SessionDurable.definitions.entries()].map(([versioned, definition]) => [
    definition.type,
    versioned,
  ]),
)
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

function server() {
  const kernel = createKernel({ sessionID, events: [] })
  const state = { seq: 0 }
  const commit = (type: string, data: Record<string, unknown>) => {
    const event: Wire = {
      kind: "durable",
      id: "evt_" + state.seq,
      type: "session.next." + type,
      versioned: versions.get("session.next." + type)!,
      seq: state.seq++,
      data: { sessionID, timestamp: 1_000 + state.seq, ...data },
    }
    kernel.commit(event)
    return event
  }
  const prompt = (id: string, delivery = "steer") => ({
    messageID: id,
    prompt: { text: id, files: [], agents: [] },
    delivery,
  })
  commit("prompted", prompt("msg_first"))
  return { kernel, commit, prompt }
}

const connected = { type: "server.connected", properties: { replay: "initial", sync: 1 } }

describe("execution status", () => {
  test("an answer that a session is idle outranks an older report that it started", async () => {
    const { kernel } = server()
    const store = createServerSession(kernel.client as unknown as ZaovraClient)
    store.apply(connected)
    await store.sync(sessionID)
    // The session starts and stops; both reports are still in transit.
    const started = kernel.setActive(true)!
    kernel.setActive(false)
    // A reconnect asks which sessions are active. The answer does not list this one.
    store.apply({ type: "server.connected", properties: { replay: "reset", sync: 1 } })
    await settle()
    store.apply(started)
    expect(store.data.session_status[sessionID]?.type ?? "idle").toBe("idle")
  })

  test("a newer report still applies after an answer", async () => {
    const { kernel } = server()
    const store = createServerSession(kernel.client as unknown as ZaovraClient)
    store.apply(connected)
    await store.sync(sessionID)
    store.apply({ type: "server.connected", properties: { replay: "reset", sync: 1 } })
    await settle()
    store.apply(kernel.setActive(true)!)
    expect(store.data.session_status[sessionID]?.type).toBe("busy")
    store.apply(kernel.setActive(false)!)
    expect(store.data.session_status[sessionID]?.type).toBe("idle")
  })

  test("a slow answer cannot undo a newer report", async () => {
    const { kernel } = server()
    const held: (() => void)[] = []
    const active = kernel.client.v2.session.execution
    const client = {
      ...kernel.client,
      v2: {
        ...kernel.client.v2,
        session: {
          ...kernel.client.v2.session,
          // The answer is computed when asked and delivered when released.
          execution: async () => {
            const answer = await active()
            await new Promise<void>((resolve) => held.push(resolve))
            return answer
          },
        },
      },
    }
    const store = createServerSession(client as unknown as ZaovraClient)
    store.apply(connected)
    await store.sync(sessionID)
    await settle()
    // Asked while idle; the session starts before the answer arrives.
    store.apply(kernel.setActive(true)!)
    held.splice(0).forEach((release) => release())
    await settle()
    expect(store.data.session_status[sessionID]?.type).toBe("busy")
  })
})

describe("switching to the ordered feed", () => {
  test("answers to requests made before the switch change nothing afterwards", async () => {
    const { kernel, commit, prompt } = server()
    const gate: { release?: () => void; asked: boolean } = { asked: false }
    const client = {
      ...kernel.client,
      v2: {
        ...kernel.client.v2,
        session: {
          ...kernel.client.v2.session,
          // The pre-switch read of pending inputs: it saw none, and its answer is late.
          pendingInputs: () => {
            gate.asked = true
            return new Promise((resolve) => {
              gate.release = () => resolve({ data: { data: [] } })
            })
          },
        },
      },
    }
    const store = createServerSession(client as unknown as ZaovraClient)
    store.pin(sessionID)
    // The session is opened before the event stream has connected.
    const early = store.sync(sessionID)
    for (let spins = 0; spins < 100 && !gate.asked; spins++) await settle()
    expect(gate.asked).toBe(true)
    commit("prompt.admitted", prompt("msg_queued", "queue"))
    store.apply(connected)
    await store.resync(sessionID)
    expect(store.data.pending_input[sessionID]?.map((input) => input.id)).toEqual(["msg_queued"])
    gate.release?.()
    await early.catch(() => undefined)
    await settle()
    expect(store.data.pending_input[sessionID]?.map((input) => input.id)).toEqual(["msg_queued"])
    expect(store.pendingDelivery(sessionID, "msg_queued")).toBe("queue")
    expect(store.history.loading(sessionID)).toBe(false)
  })
})

describe("background completions", () => {
  test("a completion whose turn cannot be known is read from the kernel, not guessed", async () => {
    const { kernel, commit, prompt } = server()
    const model = { id: "model", providerID: "provider" }
    commit("step.started", { assistantMessageID: "msg_launcher", agent: "build", model })
    // Enough later messages that the newest page does not reach the launching turn.
    for (let index = 0; index < 30; index++) commit("prompted", prompt("msg_user_" + String(index).padStart(2, "0")))
    const store = createServerSession(kernel.client as unknown as ZaovraClient)
    store.apply(connected)
    await store.sync(sessionID)
    expect(store.data.message[sessionID]?.some((message) => message.id === "msg_launcher")).toBe(false)
    const reads = kernel.counts.messages
    // An older kernel's completion event does not name its turn.
    const done = commit("prompted", {
      ...prompt("msg_done", "queue"),
      completion: { type: "bash-completion", sourceMessageID: "msg_launcher", jobID: "job" },
    })
    store.apply({ type: done.type, properties: done.data })
    store.apply({
      type: "sync",
      syncEvent: { id: done.id, type: done.versioned, seq: done.seq, aggregateID: sessionID, data: done.data },
    } as Parameters<typeof store.apply>[0])
    await settle()
    await settle()
    expect(kernel.counts.messages).toBeGreaterThan(reads)
    const notice = store.data.part.msg_done?.[0]
    expect(notice?.type === "text" && notice.metadata?.zaovraTurn).toBe("msg_first")
  })
})
