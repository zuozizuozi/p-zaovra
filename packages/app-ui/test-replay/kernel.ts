// A stand-in kernel driven by a recorded event log.
//
// It answers the session requests the desktop sync layer makes, from the same durable events a
// real kernel would have committed up to "now". Message projection uses the kernel's own reducer;
// the parts the real projector adds around it (message sequence numbers, revert deletion, pending
// inputs, the live text overlay) are mirrored here and named after their source.
import { Effect, Schema } from "effect"
import { SessionMessageUpdater } from "@zaovra-ai/core/session/message-updater"
import { Durable } from "@zaovra-ai/schema/durable-event-manifest"
import { SessionEvent } from "@zaovra-ai/schema/session-event"
import { SessionMessage } from "@zaovra-ai/schema/session-message"

export type FixtureEvent = {
  id: string
  type: string
  seq: number
  length?: number
  data: Record<string, unknown> & { sessionID: string; timestamp: number }
}
export type Fixture = { sessionID: string; events: FixtureEvent[] }

/** What travels on the event stream: every durable event, plus live-only text fragments. */
export type Wire =
  | { kind: "durable"; seq: number; id: string; type: string; versioned: string; data: FixtureEvent["data"] }
  | { kind: "live"; id: string; type: string; data: FixtureEvent["data"] }

const reducible: ReadonlySet<string> = new Set(SessionEvent.Definitions.map((definition) => definition.type))
const encodeMessage = Schema.encodeUnknownSync(SessionMessage.Message)
const base = (versioned: string) => versioned.replace(/\.\d+$/, "")

/** Durable events in order, with streamed text re-expanded into offset-tagged fragments. */
export function wire(fixture: Fixture, chunk = 24): Wire[] {
  return fixture.events.flatMap((event): Wire[] => {
    const type = base(event.type)
    const durable: Wire = {
      kind: "durable",
      seq: event.seq,
      id: event.id,
      type,
      versioned: event.type,
      data: event.data,
    }
    if (type !== "session.next.text.ended" && type !== "session.next.reasoning.ended") return [durable]
    const text = typeof event.data.text === "string" ? event.data.text : ""
    const fragments = Array.from({ length: Math.ceil(text.length / chunk) }, (_, index): Wire => {
      const offset = index * chunk
      return {
        kind: "live",
        id: `${event.id}:delta:${index}`,
        type: type.replace(".ended", ".delta"),
        data: {
          timestamp: event.data.timestamp,
          sessionID: event.data.sessionID,
          assistantMessageID: event.data.assistantMessageID,
          ...(event.data.textID === undefined
            ? { reasoningID: event.data.reasoningID }
            : { textID: event.data.textID }),
          delta: text.slice(offset, offset + chunk),
          offset,
        },
      }
    })
    return [...fragments, durable]
  })
}

export function createKernel(fixture: Fixture) {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  const created = new Map<string, number>()
  // session/live.ts: in-flight text keyed by assistant message, then by part.
  const live = new Map<string, Map<string, string>>()
  // session/input.ts: admitted, not yet promoted or cancelled.
  const pending = new Map<string, { seq: number; data: Record<string, unknown> }>()
  const counts = { get: 0, messages: 0, pending: 0, active: 0, wait: 0, message: 0, history: 0, rows: 0 }
  const waiters = new Set<() => void>()
  const log: Wire[] = []
  let watermark = -1
  let current = -1
  let active = false
  // session/execution/local.ts: status reports are ordered by process start and a change counter.
  const epoch = 1
  let revision = 0
  let inflight = 0
  let title = fixture.sessionID
  let info: Record<string, unknown> = {}

  const memory = SessionMessageUpdater.memory(state)
  const adapter: SessionMessageUpdater.Adapter = {
    ...memory,
    appendMessage: (message) =>
      memory.appendMessage(message).pipe(Effect.tap(() => Effect.sync(() => created.set(message.id, current)))),
  }

  const commit = (event: Wire) => {
    log.push(event)
    if (event.kind === "live") {
      const messageID = String(event.data.assistantMessageID)
      const key = event.data.textID === undefined ? `reasoning:${event.data.reasoningID}` : `text:${event.data.textID}`
      const parts = new Map(live.get(messageID))
      parts.set(key, (parts.get(key) ?? "") + String(event.data.delta))
      live.set(messageID, parts)
      return
    }
    if (event.seq !== watermark + 1) throw new Error(`Fixture sequence gap at ${event.seq}`)
    current = event.seq
    const definition = Durable.get(event.versioned)
    if (!definition) throw new Error(`Unknown durable event ${event.versioned}`)
    const data = Schema.decodeUnknownSync(definition.data)(event.data) as Record<string, unknown>
    if (event.type === "session.next.created") info = event.data
    if (event.type === "session.next.updated" && typeof event.data.title === "string") title = event.data.title
    if (event.type === "session.next.prompt.admitted")
      pending.set(String(event.data.messageID), { seq: event.seq, data: event.data })
    if (event.type === "session.next.prompted" || event.type === "session.next.prompt.cancelled")
      pending.delete(String(event.data.messageID))
    if (event.type === "session.next.text.started" || event.type === "session.next.reasoning.started") {
      const messageID = String(event.data.assistantMessageID)
      const key = event.data.textID === undefined ? `reasoning:${event.data.reasoningID}` : `text:${event.data.textID}`
      live.set(messageID, new Map(live.get(messageID)).set(key, ""))
    }
    if (event.type === "session.next.step.ended" || event.type === "session.next.step.failed")
      live.delete(String(event.data.assistantMessageID))
    if (event.type === "session.next.revert.committed") {
      // session/projector.ts: everything after the boundary message is removed.
      const boundary = created.get(String(event.data.messageID))
      if (boundary === undefined) throw new Error(`Revert boundary missing: ${event.data.messageID}`)
      state.messages = state.messages.filter((message) => (created.get(message.id) ?? 0) <= boundary)
      for (const [id, input] of pending) if (input.seq > boundary) pending.delete(id)
    }
    if (reducible.has(event.type))
      Effect.runSync(
        SessionMessageUpdater.update(adapter, {
          id: event.id,
          type: event.type,
          durable: { aggregateID: fixture.sessionID, seq: event.seq, version: definition.durable!.version },
          data,
        } as SessionEvent.Event),
      )
    watermark = event.seq
  }

  const overlay = (message: SessionMessage.Message) => {
    if (message.type !== "assistant") return message
    const parts = live.get(message.id)
    if (!parts) return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "text" && part.type !== "reasoning") return part
        const text = parts.get(`${part.type}:${part.id}`)
        return text !== undefined && text.startsWith(part.text) ? { ...part, text } : part
      }),
    }
  }

  /** Newest first, like the real query; `before` is the sequence of the oldest message already held. */
  const page = (limit: number, before?: number) =>
    state.messages
      .map((message) => ({ message, seq: created.get(message.id)! }))
      .filter((row) => before === undefined || row.seq < before)
      .toSorted((a, b) => b.seq - a.seq)
      .slice(0, limit)

  const admitted = () =>
    [...pending.entries()].map(([id, input]) => ({
      admittedSeq: input.seq,
      id,
      sessionID: fixture.sessionID,
      timeCreated: input.data.timestamp,
      prompt: input.data.prompt,
      delivery: input.data.delivery ?? "steer",
      ...(input.data.completion ? { completion: input.data.completion } : {}),
    }))

  const request = async <T>(name: keyof typeof counts, read: () => T) => {
    counts[name]++
    inflight++
    // Every response crosses at least one task boundary, as an HTTP round trip would.
    await new Promise((resolve) => setTimeout(resolve, 0))
    inflight--
    return read()
  }

  const client = {
    v2: {
      question: { request: { list: () => request("active", () => ({ data: { data: [] } })) } },
      permission: { request: { list: () => request("active", () => ({ data: { data: [] } })) } },
      session: {
        interrupt: async () => undefined,
        todos: async () => ({ data: { data: [] } }),
        get: () =>
          request("get", () => ({
            data: {
              data: {
                id: fixture.sessionID,
                projectID: info.projectID ?? "project",
                agent: info.agent ?? "build",
                model: info.model ?? { id: "model", providerID: "provider" },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: info.timestamp ?? 0, updated: info.timestamp ?? 0 },
                title,
                location: { directory: "/replay" },
              },
            },
          })),
        messages: (input: { limit?: number; cursor?: string }) =>
          request("messages", () => {
            const rows = page(input.limit ?? 50, input.cursor === undefined ? undefined : Number(input.cursor))
            counts.rows += rows.length
            const more = rows.length > 0 && page(1, rows.at(-1)!.seq).length > 0
            return {
              data: {
                data: rows.map((row) => encodeMessage(overlay(row.message))),
                cursor: { next: more ? String(rows.at(-1)!.seq) : undefined },
                watermark,
                execution: { epoch, revision, active },
                pending: admitted(),
              },
            }
          }),
        message: (input: { messageID: string }) =>
          request("message", () => {
            const found = state.messages.find((message) => message.id === input.messageID)
            return { data: found ? { data: encodeMessage(overlay(found)) } : undefined }
          }),
        history: (input: { after?: number; limit?: number }) =>
          request("history", () => {
            const events = log.flatMap((event) =>
              event.kind === "durable" && event.seq > (input.after ?? -1) ? [event] : [],
            )
            const limit = input.limit ?? 50
            return {
              data: {
                data: events.slice(0, limit).map((event) => ({
                  id: event.id,
                  type: event.type,
                  durable: {
                    aggregateID: fixture.sessionID,
                    seq: event.seq,
                    version: Number(event.versioned.slice(event.type.length + 1)),
                  },
                  data: event.data,
                })),
                hasMore: events.length > limit,
              },
            }
          }),
        pendingInputs: () => request("pending", () => ({ data: { data: admitted() } })),
        active: () =>
          request("active", () => ({
            data: { data: active ? { [fixture.sessionID]: { type: "running" } } : {}, epoch, revision },
          })),
        wait: async () => {
          counts.wait++
          if (active) await new Promise<void>((resolve) => waiters.add(resolve))
        },
      },
    },
    vcs: { diff: async () => ({ data: [] }) },
    session: { diff: async () => ({ data: [] }), todo: async () => ({ data: [] }) },
  }

  return {
    client,
    counts,
    commit,
    watermark: () => watermark,
    /** Inputs the user sent that the kernel has admitted but not yet promoted into history. */
    pending: () => [...pending.keys()],
    inflight: () => inflight,
    /** The projected history a fresh reader would receive right now, oldest first. */
    snapshot: () =>
      page(Number.MAX_SAFE_INTEGER)
        .toReversed()
        .map((row) => encodeMessage(overlay(row.message))),
    /** Returns the status event the kernel publishes when this changes anything. */
    setActive(next: boolean) {
      if (active === next) return
      active = next
      revision++
      if (!next) {
        waiters.forEach((resolve) => resolve())
        waiters.clear()
      }
      return {
        type: "session.execution.status",
        properties: { sessionID: fixture.sessionID, active, epoch, revision },
      }
    },
  }
}
