// Feeds a recorded session to the desktop sync layer the way the event stream would, and checks
// the sync contract's invariants (specs/v2/desktop-sync.md) at every quiet point.
import type { Message, Part, SessionMessage, SessionV2Info, ZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { createServerSession } from "../src/context/server-session"
import { adaptSessionMessages } from "../src/context/v2-session-adapter"
import { createKernel, wire, type Fixture, type Wire } from "./kernel"

export type Delivery =
  | { event: Wire }
  /** The stream dropped and came back; `replayed` says whether the server could resend what was missed. */
  | { reconnect: true }

export type Plan = {
  /** Commit index at which the user opens the session; earlier history arrives only by snapshot. */
  openAt?: number
  /** Reorders, repeats or drops deliveries. Commit order on the kernel never changes. */
  deliver?: (events: Wire[]) => Delivery[][]
  /** Page size used when opening, as the app does. */
  window?: number
}

const work = /^session\.next\.(prompted|step\.|tool\.|text\.|reasoning\.|shell\.|retried|compaction\.)/

/** Whether the kernel still has work for this user request after event `index`. */
function busyAfter(events: Wire[]) {
  const result = Array.from({ length: events.length }, () => false)
  let ahead = false
  for (let index = events.length - 1; index >= 0; index--) {
    result[index] = ahead
    const type = events[index]!.type
    if (work.test(type)) ahead = true
    if (type === "session.next.prompt.admitted") {
      result[index] = ahead
      ahead = false
    }
  }
  return result
}

type Normal = {
  id: string
  role: string
  parent?: string
  done: boolean
  finish?: string
  failed: boolean
  parts: { id: string; type: string; text?: string; tool?: string; status?: string }[]
}

function normalize(message: Message, parts: readonly Part[]): Normal {
  return {
    id: message.id,
    role: message.role,
    parent: message.role === "assistant" ? message.parentID : undefined,
    done: message.role === "assistant" ? message.time.completed !== undefined : true,
    finish: message.role === "assistant" ? message.finish : undefined,
    failed: message.role === "assistant" ? message.error !== undefined : false,
    parts: parts.map((part) => ({
      id: part.id,
      type: part.type,
      text: part.type === "text" || part.type === "reasoning" ? part.text : undefined,
      tool: part.type === "tool" ? part.tool : undefined,
      status: part.type === "tool" ? part.state.status : undefined,
    })),
  }
}

export async function replay(fixture: Fixture, plan: Plan = {}) {
  const kernel = createKernel(fixture)
  const events = wire(fixture)
  const busy = busyAfter(events)
  const deliveries = plan.deliver?.(events) ?? events.map((event): Delivery[] => [{ event }])
  const store = createServerSession(kernel.client as unknown as ZaovraClient)
  const sessionID = fixture.sessionID
  // One entry per broken rule: how often, and the first occurrence.
  const violations: Record<string, { count: number; first: string }> = {}
  const owners = new Map<string, string>()
  const report = (rule: string, at: number, detail: string) => {
    const entry = (violations[rule] ??= { count: 0, first: `@${at}: ${detail}` })
    entry.count++
  }
  let opened = false
  let baseline = { ...kernel.counts }
  let checks = 0

  const settle = async () => {
    const total = () => Object.values(kernel.counts).reduce((sum, value) => sum + value, 0)
    for (let quiet = 0, spins = 0; quiet < 2 && spins < 80; spins++) {
      const before = total()
      await new Promise((resolve) => setTimeout(resolve, 60))
      quiet = kernel.inflight() === 0 && total() === before ? quiet + 1 : 0
    }
  }

  const check = (at: number) => {
    checks++
    const held = (store.data.message[sessionID] ?? []) as Message[]
    const ids = held.map((message) => message.id)
    // I2: nothing is shown twice.
    if (new Set(ids).size !== ids.length) report("I2 duplicate message", at, ids.join(","))
    for (const message of held) {
      const parts = (store.data.part[message.id] ?? []).map((part) => part.id)
      if (new Set(parts).size !== parts.length) report("I2 duplicate part", at, `${message.id}: ${parts.join(",")}`)
    }
    // I3: incremental state equals what a fresh snapshot at the same watermark would show.
    const session = { id: sessionID, location: { directory: "/replay" } } as SessionV2Info
    const expected = adaptSessionMessages(session, kernel.snapshot() as SessionMessage[])
    const order = new Map(expected.map((item, index) => [item.message.id, index]))
    const known = held.filter((message) => order.has(message.id))
    const waiting = new Set(kernel.pending())
    const unknown = held.filter((message) => !order.has(message.id) && !waiting.has(message.id))
    if (unknown.length) report("I3 not in history", at, unknown.map((message) => message.id).join(","))
    const oldest = Math.min(...known.map((message) => order.get(message.id)!))
    const missing = expected
      .slice(Number.isFinite(oldest) ? oldest : expected.length)
      .filter((item) => !known.some((message) => message.id === item.message.id))
    if (missing.length) report("I3 missing", at, missing.map((item) => item.message.id).join(","))
    for (const message of known) {
      const want = expected[order.get(message.id)!]!
      const have = normalize(message, store.data.part[message.id] ?? [])
      const wanted = normalize(want.message, want.parts)
      if (have.parent !== wanted.parent)
        report("I3 owner differs from snapshot", at, `${message.id}: ${have.parent} vs ${wanted.parent}`)
      const actual = JSON.stringify({ ...have, parent: undefined })
      const content = JSON.stringify({ ...wanted, parent: undefined })
      if (actual !== content)
        report(
          "I3 content differs from snapshot",
          at,
          `${message.id} have ${actual.slice(0, 400)} want ${content.slice(0, 400)}`,
        )
      // I6: a reply never moves to another turn.
      if (message.role !== "assistant") continue
      const previous = owners.get(message.id)
      if (previous && previous !== message.parentID)
        report("I6 owner changed", at, `${message.id}: ${previous} -> ${message.parentID}`)
      owners.set(message.id, message.parentID)
    }
  }

  for (let index = 0; index < events.length; index++) {
    kernel.commit(events[index]!)
    kernel.setActive(busy[index]!)
    if (!opened) {
      if (index < (plan.openAt ?? 0)) continue
      store.pin(sessionID)
      await store.sync(sessionID, { messageLimit: plan.window })
      await settle()
      opened = true
      baseline = { ...kernel.counts }
      check(index)
      continue
    }
    for (const delivery of deliveries[index] ?? []) {
      if ("reconnect" in delivery) store.apply({ type: "server.connected", properties: {} })
      else store.apply({ id: delivery.event.id, type: delivery.event.type, properties: delivery.event.data })
    }
    const type = events[index]!.type
    if (type !== "session.next.step.ended" && type !== "session.next.step.failed") continue
    await settle()
    check(index)
  }
  await settle()
  check(events.length)
  // I5: once the kernel has nothing left to do, the session reads as idle.
  const status = store.data.session_status[sessionID]?.type ?? "idle"
  if (status !== "idle") report("I5 not idle", events.length, status)

  return {
    violations,
    checks,
    events: events.length,
    delivered: events.length - (plan.openAt ?? 0),
    requests: Object.fromEntries(
      Object.entries(kernel.counts).map(([name, value]) => [name, value - baseline[name as keyof typeof baseline]]),
    ) as typeof kernel.counts,
    held: (store.data.message[sessionID] ?? []).length,
    history: kernel.snapshot().length,
  }
}

const durable = (event: Wire) => event.kind === "durable"

/** Two neighbouring durable events arrive in the wrong order, as concurrent publishers can cause. */
export const swapped = (every: number) => (events: Wire[]) => {
  const result = events.map((event): Delivery[] => [{ event }])
  for (let index = every; index + 1 < events.length; index += every) {
    if (!durable(events[index]!) || !durable(events[index + 1]!)) continue
    result[index] = []
    result[index + 1] = [{ event: events[index + 1]! }, { event: events[index]! }]
  }
  return result
}

/** The same event is delivered twice, as a replay after reconnect can cause. */
export const repeated = (every: number) => (events: Wire[]) =>
  events.map((event, index): Delivery[] => (index % every === 0 ? [{ event }, { event }] : [{ event }]))

/** The stream drops `count` events every `every`; the server either resends them after reconnecting or cannot. */
export const dropped = (every: number, count: number, resend: boolean) => (events: Wire[]) => {
  const result = events.map((event): Delivery[] => [{ event }])
  for (let start = every; start + count < events.length; start += every) {
    const missed = events.slice(start, start + count)
    for (let index = start; index < start + count; index++) result[index] = []
    result[start + count] = [
      { reconnect: true },
      ...(resend ? missed.map((event): Delivery => ({ event })) : []),
      { event: events[start + count]! },
    ]
  }
  return result
}

/** Opens a finished session and scrolls back to its first message, one page at a time. */
export async function pageThrough(fixture: Fixture, window = 20) {
  const kernel = createKernel(fixture)
  for (const event of wire(fixture)) kernel.commit(event)
  const store = createServerSession(kernel.client as unknown as ZaovraClient)
  const sessionID = fixture.sessionID
  store.pin(sessionID)
  await store.sync(sessionID, { messageLimit: window })
  for (let pages = 0; store.history.more(sessionID) && pages < 500; pages++)
    await store.history.loadMore(sessionID, window)
  const session = { id: sessionID, location: { directory: "/replay" } } as SessionV2Info
  const expected = adaptSessionMessages(session, kernel.snapshot() as SessionMessage[]).map((item) => item.message.id)
  const held = ((store.data.message[sessionID] ?? []) as Message[]).map((message) => message.id)
  return {
    complete: store.history.complete(sessionID),
    missing: expected.filter((id) => !held.includes(id)),
    extra: held.filter((id) => !expected.includes(id)),
    duplicates: held.length - new Set(held).size,
    requests: kernel.counts.messages,
    history: expected.length,
  }
}
