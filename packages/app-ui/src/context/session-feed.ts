// One Session's transcript, kept equal to the kernel's by the rules in specs/v2/desktop-sync.md.
//
// The feed holds the kernel's own message shape for a contiguous run of the newest messages. A
// snapshot page gives it a starting point and a watermark; after that, durable events apply once
// and in sequence order through the kernel's own reducer, and stream fragments only ever extend
// text that has not ended. It performs no I/O: the caller fetches pages and history and hands
// them in.
import { Effect, Option, Schema } from "effect"
import { DurableEventManifest } from "@zaovra-ai/schema/durable-event-manifest"
import { SessionEvent } from "@zaovra-ai/schema/session-event"
import { SessionMessage } from "@zaovra-ai/schema/session-message"
import { SessionMessageUpdater } from "@zaovra-ai/schema/session-message-updater"
import type { SessionInputAdmitted } from "@zaovra-ai/sdk/v2/client"

/** A durable Session event as the `sync` stream entry and `session.history` carry it: stored form, versioned type. */
export type FeedEvent = { id: string; type: string; seq: number; data: unknown }
export type FeedPage = { data: readonly unknown[]; watermark: number; pending?: readonly SessionInputAdmitted[] }
export type FeedFragment = { messageID: string; kind: "text" | "reasoning"; id: string; delta: string; offset?: number }
export type FeedRetry = { attempt: number; message: string; next: number }

const reducible: ReadonlySet<string> = new Set(SessionEvent.Definitions.map((definition) => definition.type))
const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeUnknownSync(SessionMessage.Message)
// Enough to bring an older page up to date after any realistic request latency.
const tailLimit = 1024
const bufferLimit = 4096
const heldLimit = 256

const partKey = (messageID: string, kind: string, id: string) => `${messageID}\n${kind}\n${id}`
const bySequence = (a: SessionMessage.Message, b: SessionMessage.Message) => (a.seq ?? 0) - (b.seq ?? 0)

export function createSessionFeed(
  sessionID: string,
  /** Told about each durable event as it applies, in order, with the event's stored data. */
  observe?: (type: string, data: Record<string, unknown>) => void,
) {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  const memory = SessionMessageUpdater.memory(state)
  // Durable events that arrived before their predecessors, or before the first snapshot.
  const buffer = new Map<number, FeedEvent>()
  const pending = new Map<string, SessionInputAdmitted>()
  // Stream fragments that cannot be placed yet, per part, by offset.
  const held = new Map<string, Map<number, string>>()
  // Parts whose durable end has applied. Nothing may change their text afterwards.
  const ended = new Set<string>()
  const wire = new WeakMap<SessionMessage.Message, unknown>()
  const current = {
    applied: -1,
    ready: false,
    stale: false,
    generation: 0,
    tail: [] as FeedEvent[],
    retry: undefined as FeedRetry | undefined,
  }

  const read = (items: readonly unknown[]) =>
    items
      .map((item) => {
        const message = decodeMessage(item)
        wire.set(message, item)
        return message
      })
      .toSorted(bySequence)

  /** Extends one part with every held fragment that now fits. Returns the new text when it grew. */
  const place = (messageID: string, kind: "text" | "reasoning", id: string) => {
    const key = partKey(messageID, kind, id)
    const fragments = held.get(key)
    if (!fragments) return
    if (ended.has(key)) return void held.delete(key)
    const index = state.messages.findLastIndex((message) => message.id === messageID)
    const message = state.messages[index]
    if (message?.type !== "assistant") return
    const position = message.content.findLastIndex((part) => part.type === kind && part.id === id)
    const part = message.content[position]
    if (!part || (part.type !== "text" && part.type !== "reasoning")) return
    let text = part.text
    for (let progressed = true; progressed; ) {
      progressed = false
      for (const [offset, delta] of fragments) {
        if (offset > text.length) continue
        fragments.delete(offset)
        if (offset + delta.length <= text.length) continue
        text += delta.slice(text.length - offset)
        progressed = true
      }
    }
    if (fragments.size === 0) held.delete(key)
    if (text === part.text) return
    state.messages[index] = { ...message, content: message.content.with(position, { ...part, text }) }
    return text
  }

  const placeAll = () => {
    for (const key of [...held.keys()]) {
      const [messageID, kind, id] = key.split("\n")
      place(messageID!, kind === "reasoning" ? "reasoning" : "text", id!)
    }
  }

  const reduce = (
    adapter: SessionMessageUpdater.Adapter,
    event: FeedEvent,
    type: string,
    version: number,
    data: unknown,
  ) =>
    Effect.runSync(
      SessionMessageUpdater.update(adapter, {
        id: event.id,
        type,
        durable: { aggregateID: sessionID, seq: event.seq, version },
        data,
      } as SessionEvent.Event),
    )

  const decode = (event: FeedEvent) => {
    const definition = DurableEventManifest.SessionDurable.definitions.get(event.type)
    if (!definition?.durable) return
    const data = Schema.decodeUnknownOption(definition.data)(event.data)
    if (Option.isNone(data)) return "unreadable" as const
    return { type: definition.type, version: definition.durable.version, data: data.value as Record<string, unknown> }
  }

  /** Incremental state can no longer be trusted. Keep what is shown until a new snapshot replaces it. */
  const abandon = () => {
    current.ready = false
    current.stale = true
    current.generation++
    current.tail = []
    buffer.clear()
  }

  const apply = (event: FeedEvent) => {
    const decoded = decode(event)
    // A known event whose data does not decode would silently diverge from the kernel's projection.
    if (decoded === "unreadable") return abandon()
    // Events of a type this client does not know still take their place in the sequence.
    if (decoded) {
      const raw = event.data as Record<string, unknown>
      const messageID = typeof raw.messageID === "string" ? raw.messageID : undefined
      if (decoded.type === "session.next.prompt.admitted" && messageID)
        pending.set(messageID, {
          admittedSeq: event.seq,
          id: messageID,
          sessionID,
          prompt: raw.prompt,
          delivery: raw.delivery ?? "steer",
          ...(raw.completion ? { completion: raw.completion } : {}),
          timeCreated: raw.timestamp,
        } as SessionInputAdmitted)
      if ((decoded.type === "session.next.prompted" || decoded.type === "session.next.prompt.cancelled") && messageID)
        pending.delete(messageID)
      if (decoded.type === "session.next.retried") {
        const error = raw.error as { message?: string; metadata?: Record<string, string> } | undefined
        const delay = Number(error?.metadata?.delayMs ?? 0)
        current.retry = {
          attempt: Number(raw.attempt ?? 0),
          message: error?.message ?? "",
          next: Number(raw.timestamp) + (Number.isFinite(delay) ? Math.max(0, delay) : 0),
        }
      }
      if (decoded.type === "session.next.step.started") current.retry = undefined
      if (decoded.type === "session.next.text.ended" || decoded.type === "session.next.reasoning.ended") {
        const key = partKey(
          String(raw.assistantMessageID),
          raw.textID === undefined ? "reasoning" : "text",
          String(raw.textID ?? raw.reasoningID),
        )
        ended.add(key)
        held.delete(key)
      }
      if (decoded.type === "session.next.revert.committed") {
        // The projector removes every message and input recorded after the boundary message.
        const boundary = state.messages.find((message) => message.id === messageID)?.seq
        // The boundary is older than anything held, so nothing held survives. Start over.
        if (boundary === undefined) return abandon()
        state.messages = state.messages.filter((message) => (message.seq ?? 0) <= boundary)
        for (const [id, input] of pending) if (input.admittedSeq > boundary) pending.delete(id)
      }
      if (reducible.has(decoded.type)) reduce(memory, event, decoded.type, decoded.version, decoded.data)
      observe?.(decoded.type, raw)
    }
    current.applied = event.seq
    current.tail.push(event)
    if (current.tail.length > tailLimit) current.tail.splice(0, current.tail.length - tailLimit)
  }

  const drain = () => {
    for (let next = buffer.get(current.applied + 1); next && current.ready; next = buffer.get(current.applied + 1)) {
      buffer.delete(next.seq)
      apply(next)
    }
    for (const seq of buffer.keys()) if (current.ready && seq <= current.applied) buffer.delete(seq)
    placeAll()
  }

  return {
    get ready() {
      return current.ready
    },
    /** What is held can no longer be brought up to date event by event; the newest page has to be read again. */
    get stale() {
      return current.stale
    },
    /** The highest sequence applied without a gap. */
    get applied() {
      return current.applied
    },
    /** Changes whenever history was rewritten, so a page requested before that can be recognised. */
    get generation() {
      return current.generation
    },
    get retry() {
      return current.retry
    },
    /** A durable event is waiting for a predecessor that has not arrived. */
    get gap() {
      return current.ready && buffer.size > 0
    },
    /** Held messages in transcript order, as the kernel would return them. */
    messages() {
      return state.messages.map((message) => {
        const cached = wire.get(message)
        if (cached) return cached
        const encoded = encodeMessage(message)
        wire.set(message, encoded)
        return encoded
      })
    },
    pending() {
      return [...pending.values()]
    },
    /** Whether the oldest held message starts a turn, so nothing held is waiting for its user message. */
    rooted() {
      const type = state.messages[0]?.type
      return type === undefined || type === "user" || type === "synthetic" || type === "shell"
    },
    /** Whether a page has seen events this feed has not applied yet. */
    behind(page: FeedPage) {
      return current.ready && page.watermark > current.applied
    },
    /** Whether any held text is still being written. */
    streaming() {
      return state.messages.flatMap((message) =>
        message.type === "assistant" && message.time.completed === undefined ? [String(message.id)] : [],
      )
    },
    /**
     * Starts from the newest page. A page older than the state already held is refused unless
     * `replace` says the server's history itself changed (another process, a restored database).
     */
    open(page: FeedPage, replace = false) {
      if (current.ready && !replace && page.watermark < current.applied) return false
      state.messages = read(page.data)
      pending.clear()
      for (const input of page.pending ?? []) pending.set(input.id, input)
      ended.clear()
      current.applied = page.watermark
      current.ready = true
      current.stale = false
      current.tail = []
      current.retry = undefined
      current.generation++
      drain()
      return true
    },
    /**
     * Adds an older page in front of what is held.
     * - `behind`: the page has seen events this feed has not applied yet; catch up, then try again.
     * - `expired`: too much happened since the page was read; read it again.
     */
    prepend(page: FeedPage, generation: number) {
      if (!current.ready || generation !== current.generation) return "expired" as const
      if (page.watermark > current.applied) return "behind" as const
      const missed = current.tail.filter((event) => event.seq > page.watermark)
      if (page.watermark < current.applied && (current.tail[0]?.seq ?? Infinity) > page.watermark + 1)
        return "expired" as const
      const oldest = state.messages[0]?.seq ?? Infinity
      const known = new Set(state.messages.map((message) => message.id))
      const older: SessionMessageUpdater.MemoryState = {
        messages: read(page.data).filter((message) => !known.has(message.id) && (message.seq ?? 0) < oldest),
      }
      const scoped = SessionMessageUpdater.memory(older)
      for (const event of missed) {
        const decoded = decode(event)
        if (!decoded || decoded === "unreadable" || !reducible.has(decoded.type)) continue
        // Events since the page was read may have changed its messages, but never add to it: every
        // message they created is newer than the page. A step only closes the page's last unfinished
        // assistant if no newer assistant existed at that point, as the kernel decides it.
        reduce(
          {
            ...scoped,
            appendMessage: () => Effect.void,
            getTurn: () => Effect.succeed(undefined),
            getCurrentAssistant: () =>
              state.messages.some((message) => message.type === "assistant" && (message.seq ?? 0) < event.seq)
                ? Effect.succeed(undefined)
                : scoped.getCurrentAssistant(),
            getCurrentShell: (callID) =>
              state.messages.some((message) => message.type === "shell" && message.callID === callID)
                ? Effect.succeed(undefined)
                : scoped.getCurrentShell(callID),
          },
          event,
          decoded.type,
          decoded.version,
          decoded.data,
        )
      }
      state.messages = [...older.messages, ...state.messages]
      placeAll()
      return "merged" as const
    },
    /** One durable event from the stream, in any order and any number of times. */
    durable(event: FeedEvent) {
      if (current.ready && event.seq <= current.applied) return
      buffer.set(event.seq, event)
      if (buffer.size > bufferLimit) buffer.delete(Math.min(...buffer.keys()))
      if (current.ready) drain()
    },
    /**
     * Events read from `session.history`, oldest first. The log is read in order, so a sequence it
     * skips belongs to something this client does not show and is not a gap.
     */
    history(events: readonly FeedEvent[]) {
      if (!current.ready) return
      for (const event of events) {
        if (event.seq <= current.applied) continue
        buffer.delete(event.seq)
        apply(event)
        if (!current.ready) return
      }
      drain()
    },
    /** One stream fragment. Returns the part's new text when the fragment could be placed. */
    fragment(input: FeedFragment) {
      const key = partKey(input.messageID, input.kind, input.id)
      if (ended.has(key)) return
      const index = state.messages.findLastIndex((message) => message.id === input.messageID)
      const message = state.messages[index]
      if (message?.type === "assistant" && message.time.completed !== undefined) return
      if (input.offset === undefined) {
        // An older kernel sends no offset. Appending is all that can be done, and only to a known part.
        if (message?.type !== "assistant") return
        const position = message.content.findLastIndex((part) => part.type === input.kind && part.id === input.id)
        const part = message.content[position]
        if (!part || (part.type !== "text" && part.type !== "reasoning")) return
        const text = part.text + input.delta
        state.messages[index] = { ...message, content: message.content.with(position, { ...part, text }) }
        return text
      }
      const fragments = held.get(key) ?? new Map<number, string>()
      fragments.set(input.offset, input.delta)
      // A gap that never closes is settled by the part's end event; stop collecting behind it.
      if (fragments.size > heldLimit) fragments.clear()
      held.set(key, fragments)
      return place(input.messageID, input.kind, input.id)
    },
    /**
     * Text read from the kernel for a part that is still being written. It may only extend what is
     * shown: a response that was already overtaken by the part's end changes nothing.
     */
    extend(messageID: string, kind: "text" | "reasoning", id: string, text: string) {
      if (ended.has(partKey(messageID, kind, id))) return
      const index = state.messages.findLastIndex((message) => message.id === messageID)
      const message = state.messages[index]
      if (message?.type !== "assistant" || message.time.completed !== undefined) return
      const position = message.content.findLastIndex((part) => part.type === kind && part.id === id)
      const part = message.content[position]
      if (!part || (part.type !== "text" && part.type !== "reasoning")) return
      if (text.length <= part.text.length || !text.startsWith(part.text)) return
      state.messages[index] = { ...message, content: message.content.with(position, { ...part, text }) }
      place(messageID, kind, id)
      return true
    },
  }
}

export type SessionFeed = ReturnType<typeof createSessionFeed>
