import { describe, expect, test } from "bun:test"
import { DurableEventManifest } from "@zaovra-ai/schema/durable-event-manifest"
import { createSessionFeed, type FeedEvent } from "./session-feed"

const sessionID = "ses_feed"
const model = { id: "model", providerID: "provider" }
const versions = new Map<string, string>(
  [...DurableEventManifest.SessionDurable.definitions.entries()].map(([versioned, definition]) => [
    definition.type,
    versioned,
  ]),
)

/** Builds a session's event log the way the kernel stores it. */
function script() {
  const events: FeedEvent[] = []
  const add = (type: string, data: Record<string, unknown>) => {
    const event = {
      id: `evt_${events.length}`,
      type: versions.get(`session.next.${type}`)!,
      seq: events.length,
      data: { timestamp: 1_000 + events.length, sessionID, ...data },
    }
    events.push(event)
    return event
  }
  return {
    events,
    admit: (id: string, delivery = "steer") =>
      add("prompt.admitted", { messageID: id, prompt: { text: id, files: [], agents: [] }, delivery }),
    prompt: (id: string) =>
      add("prompted", { messageID: id, prompt: { text: id, files: [], agents: [] }, delivery: "steer" }),
    step: (id: string) => add("step.started", { assistantMessageID: id, agent: "build", model }),
    text: (id: string, part = "t0") => add("text.started", { assistantMessageID: id, textID: part }),
    textEnd: (id: string, text: string, part = "t0") =>
      add("text.ended", { assistantMessageID: id, textID: part, text }),
    tool: (id: string, call: string) => {
      add("tool.input.started", { assistantMessageID: id, callID: call, name: "read" })
      add("tool.input.ended", { assistantMessageID: id, callID: call, text: "{}" })
      return add("tool.called", {
        assistantMessageID: id,
        callID: call,
        tool: "read",
        input: {},
        provider: { executed: false },
      })
    },
    toolDone: (id: string, call: string) =>
      add("tool.success", {
        assistantMessageID: id,
        callID: call,
        structured: {},
        content: [{ type: "text", text: "done" }],
        provider: { executed: false },
      }),
    end: (id: string) =>
      add("step.ended", {
        assistantMessageID: id,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    revert: (id: string) => add("revert.committed", { messageID: id }),
  }
}

/** What the kernel would answer for a message page right after `count` events. */
function page(events: readonly FeedEvent[], count: number, select = (ids: string[]) => ids) {
  const kernel = createSessionFeed(sessionID)
  kernel.open({ data: [], watermark: -1 })
  events.slice(0, count).forEach((event) => kernel.durable(event))
  const messages = kernel.messages() as { id: string }[]
  const wanted = new Set(select(messages.map((message) => message.id)))
  return {
    data: messages.filter((message) => wanted.has(message.id)),
    watermark: count - 1,
    pending: kernel.pending(),
  }
}

const shape = (feed: ReturnType<typeof createSessionFeed>) =>
  (feed.messages() as Record<string, any>[]).map((message) => ({
    id: message.id,
    done: message.type === "assistant" ? message.time.completed !== undefined : undefined,
    parts:
      message.type === "assistant"
        ? message.content.map((part: Record<string, any>) => part.text ?? part.state.status)
        : undefined,
  }))

describe("durable events", () => {
  test("apply once and in order however they arrive", () => {
    const log = script()
    log.prompt("msg_u1")
    log.step("msg_a1")
    log.text("msg_a1")
    log.textEnd("msg_a1", "hello")
    log.end("msg_a1")
    const expected = page(log.events, log.events.length)

    const feed = createSessionFeed(sessionID)
    // Events that arrive before the first snapshot wait for it.
    feed.durable(log.events[1]!)
    feed.open(page(log.events, 1))
    expect(feed.applied).toBe(1)
    // Swapped neighbours and repeats.
    feed.durable(log.events[3]!)
    expect(feed.gap).toBe(true)
    feed.durable(log.events[2]!)
    feed.durable(log.events[2]!)
    feed.durable(log.events[0]!)
    expect(feed.gap).toBe(false)
    feed.durable(log.events[4]!)
    feed.durable(log.events[3]!)
    expect(feed.applied).toBe(4)
    expect(feed.messages()).toEqual(expected.data)
  })

  test("a gap closes from history, and sequences history skips are not gaps", () => {
    const log = script()
    log.prompt("msg_u1")
    log.step("msg_a1")
    log.text("msg_a1")
    log.textEnd("msg_a1", "hello")
    log.end("msg_a1")
    const feed = createSessionFeed(sessionID)
    feed.open(page(log.events, 1))
    feed.durable(log.events[4]!)
    expect(feed.gap).toBe(true)
    // History leaves out events this client does not show; here it leaves out sequence 2.
    feed.history([log.events[1]!, log.events[3]!, log.events[4]!])
    expect(feed.gap).toBe(false)
    expect(feed.applied).toBe(4)
  })

  test("an event this client cannot read still takes its place in the sequence", () => {
    const log = script()
    log.prompt("msg_u1")
    const feed = createSessionFeed(sessionID)
    feed.open(page(log.events, 1))
    feed.durable({ id: "evt_x", type: "session.next.from.a.newer.kernel.9", seq: 1, data: {} })
    feed.durable({ ...log.step("msg_a1"), seq: 2 })
    expect(feed.applied).toBe(2)
    expect(shape(feed).map((message) => message.id)).toEqual(["msg_u1", "msg_a1"])
  })

  test("a known event that cannot be decoded stops incremental updates until a new snapshot", () => {
    const log = script()
    log.prompt("msg_u1")
    const feed = createSessionFeed(sessionID)
    feed.open(page(log.events, 1))
    feed.durable({ ...log.step("msg_a1"), data: { sessionID } })
    expect([feed.ready, feed.stale, feed.applied]).toEqual([false, true, 0])
    feed.durable(log.end("msg_a1"))
    expect(feed.open(page(log.events, 3))).toBe(true)
    expect([feed.ready, feed.stale, feed.applied]).toEqual([true, false, 2])
  })

  test("pending inputs follow admission, promotion and cancellation", () => {
    const log = script()
    const feed = createSessionFeed(sessionID)
    feed.open({ data: [], watermark: -1 })
    feed.durable(log.admit("msg_u1"))
    feed.durable(log.admit("msg_u2", "queue"))
    expect(feed.pending().map((input) => [input.id, input.delivery, input.admittedSeq])).toEqual([
      ["msg_u1", "steer", 0],
      ["msg_u2", "queue", 1],
    ])
    feed.durable(log.prompt("msg_u1"))
    expect(feed.pending().map((input) => input.id)).toEqual(["msg_u2"])
  })
})

describe("revert", () => {
  test("removes everything recorded after the boundary, like the kernel", () => {
    const log = script()
    log.prompt("msg_u1")
    log.step("msg_a1")
    log.end("msg_a1")
    log.prompt("msg_u2")
    log.step("msg_a2")
    log.end("msg_a2")
    log.admit("msg_u3", "queue")
    const feed = createSessionFeed(sessionID)
    feed.open(page(log.events, log.events.length))
    expect(feed.pending().map((input) => input.id)).toEqual(["msg_u3"])
    feed.durable(log.revert("msg_a1"))
    expect(shape(feed).map((message) => message.id)).toEqual(["msg_u1", "msg_a1"])
    expect(feed.pending()).toEqual([])
    expect(feed.stale).toBe(false)
  })

  test("with a boundary older than anything held, asks for a new snapshot and takes it", () => {
    const log = script()
    log.prompt("msg_u1")
    log.step("msg_a1")
    log.end("msg_a1")
    log.prompt("msg_u2")
    log.step("msg_a2")
    log.end("msg_a2")
    const feed = createSessionFeed(sessionID)
    const generation = (feed.open(page(log.events, 6, (ids) => ids.slice(-2))), feed.generation)
    const revert = log.revert("msg_u1")
    feed.durable(revert)
    expect(feed.stale).toBe(true)
    expect(feed.ready).toBe(false)
    // A page requested before the revert must not be merged afterwards.
    expect(
      feed.prepend(
        page(log.events, 6, (ids) => ids.slice(0, 2)),
        generation,
      ),
    ).toBe("expired")
    feed.open({ ...page(log.events, 1), watermark: revert.seq })
    expect(feed.stale).toBe(false)
    expect(shape(feed).map((message) => message.id)).toEqual(["msg_u1"])
  })
})

describe("older pages", () => {
  const history = () => {
    const log = script()
    log.prompt("msg_u1")
    log.step("msg_a1")
    log.tool("msg_a1", "call_1")
    // The page below is read here: the tool is still running.
    const read = log.events.length
    log.prompt("msg_u2")
    log.step("msg_a2")
    log.end("msg_a2")
    return { log, read }
  }

  test("events since the page was read change its messages but never add to it", () => {
    const { log, read } = history()
    const feed = createSessionFeed(sessionID)
    feed.open(page(log.events, log.events.length, (ids) => ids.slice(-2)))
    const generation = feed.generation
    // After the newest page was read, the old tool finishes.
    feed.durable(log.toolDone("msg_a1", "call_1"))
    const old = page(log.events, read, (ids) => ids.slice(0, 2))
    expect(feed.behind(old)).toBe(false)
    // The feed opened at a watermark past the page's and kept no events from before it.
    expect(feed.prepend(old, generation)).toBe("expired")
    // Read again now, the page already reflects the finished tool and what happened since is on hand.
    const fresh = page(log.events, log.events.length - 1, (ids) => ids.slice(0, 2))
    expect(feed.prepend(fresh, generation)).toBe("merged")
    expect(shape(feed)).toEqual([
      { id: "msg_u1", done: undefined, parts: undefined },
      // Closed when the next step started, and the tool result that arrived later is applied.
      { id: "msg_a1", done: true, parts: ["completed"] },
      { id: "msg_u2", done: undefined, parts: undefined },
      { id: "msg_a2", done: true, parts: [] },
    ])
  })

  test("a page that has seen more than the feed waits for the feed to catch up", () => {
    const { log, read } = history()
    const feed = createSessionFeed(sessionID)
    feed.open(page(log.events, read, (ids) => ids.slice(-1)))
    const generation = feed.generation
    const done = log.toolDone("msg_a1", "call_1")
    // The server committed `done` before answering; the stream has not delivered it yet.
    const old = page(log.events, log.events.length, (ids) => ids.slice(0, 1))
    expect(feed.behind(old)).toBe(true)
    expect(feed.prepend(old, generation)).toBe("behind")
    expect(shape(feed).map((message) => message.id)).toEqual(["msg_a1"])
    feed.history(log.events.slice(read))
    expect(feed.prepend(old, generation)).toBe("merged")
    expect(feed.applied).toBe(done.seq)
    expect(feed.messages()).toEqual(page(log.events, log.events.length).data)
  })

  test("paging back through a busy session equals a full read", () => {
    const { log } = history()
    log.prompt("msg_u3")
    log.step("msg_a3")
    const feed = createSessionFeed(sessionID)
    feed.open(page(log.events, log.events.length, (ids) => ids.slice(-2)))
    const generation = feed.generation
    feed.durable(log.text("msg_a3"))
    feed.durable(log.toolDone("msg_a1", "call_1"))
    feed.durable(log.textEnd("msg_a3", "answer"))
    // Each older page is read at a different moment.
    expect(
      feed.prepend(
        page(log.events, log.events.length - 1, (ids) => ids.slice(2, 4)),
        generation,
      ),
    ).toBe("merged")
    feed.durable(log.end("msg_a3"))
    expect(
      feed.prepend(
        page(log.events, log.events.length - 2, (ids) => ids.slice(0, 2)),
        generation,
      ),
    ).toBe("merged")
    expect(feed.messages()).toEqual(page(log.events, log.events.length).data)
  })
})

describe("stream fragments", () => {
  const streaming = () => {
    const log = script()
    log.prompt("msg_u1")
    log.step("msg_a1")
    const feed = createSessionFeed(sessionID)
    feed.open(page(log.events, log.events.length))
    const fragment = (delta: string, offset?: number) =>
      feed.fragment({ messageID: "msg_a1", kind: "text", id: "t0", delta, offset })
    const text = () => shape(feed)[1]!.parts[0]
    return { log, feed, fragment, text }
  }

  test("merge by offset: repeats change nothing and a gap waits until it closes", () => {
    const { log, feed, fragment, text } = streaming()
    // A fragment can overtake the event that creates its part.
    expect(fragment("Hel", 0)).toBeUndefined()
    feed.durable(log.text("msg_a1"))
    expect(text()).toBe("Hel")
    expect(fragment("Hel", 0)).toBeUndefined()
    expect(fragment("rld", 8)).toBeUndefined()
    expect(text()).toBe("Hel")
    expect(fragment("llo wo", 2)).toBe("Hello world")
  })

  test("the end event settles the text, and nothing late can change it", () => {
    const { log, feed, fragment, text } = streaming()
    feed.durable(log.text("msg_a1"))
    fragment("Hel", 0)
    fragment("XXXX", 9)
    feed.durable(log.textEnd("msg_a1", "Hello world"))
    expect(text()).toBe("Hello world")
    // A fragment and a slow read that were overtaken by the end.
    expect(fragment(" and more", 11)).toBeUndefined()
    expect(fragment("lo", 3)).toBeUndefined()
    expect(feed.extend("msg_a1", "text", "t0", "Hello world and more")).toBeUndefined()
    expect(text()).toBe("Hello world")
  })

  test("text read after a reconnect may only extend what is shown", () => {
    const { log, feed, fragment, text } = streaming()
    feed.durable(log.text("msg_a1"))
    fragment("Hello", 0)
    expect(feed.streaming()).toEqual(["msg_a1"])
    // An answer that is older than what is shown, and one that disagrees with it.
    expect(feed.extend("msg_a1", "text", "t0", "Hel")).toBeUndefined()
    expect(feed.extend("msg_a1", "text", "t0", "Goodbye, all")).toBeUndefined()
    expect(feed.extend("msg_a1", "text", "t0", "Hello wor")).toBe(true)
    // Fragments that were waiting behind the lost stretch now fit.
    expect(fragment("ld", 9)).toBe("Hello world")
    expect(text()).toBe("Hello world")
    feed.durable(log.textEnd("msg_a1", "Hello world"))
    feed.durable(log.end("msg_a1"))
    expect(feed.streaming()).toEqual([])
  })
})

describe("snapshots", () => {
  test("a page older than the state already held is refused, unless the server's history changed", () => {
    const log = script()
    log.prompt("msg_u1")
    log.step("msg_a1")
    const feed = createSessionFeed(sessionID)
    feed.open(page(log.events, 2))
    feed.durable(log.end("msg_a1"))
    expect(feed.open(page(log.events, 2))).toBe(false)
    expect(shape(feed)[1]!.done).toBe(true)
    expect(feed.open(page(log.events, 2), true)).toBe(true)
    expect(shape(feed)[1]!.done).toBe(false)
  })
})
