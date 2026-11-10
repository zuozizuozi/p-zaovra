import { expect, test } from "bun:test"
import { batch, createComponent, createComputed, createMemo, createRoot, For } from "solid-js"
import { createVirtualizer } from "@tanstack/solid-virtual"
import type { Event, SessionMessage, SessionV2Info, ZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { createServerSession } from "../../src/context/server-session"
import { createTimelineProjection } from "../../src/pages/session/timeline/projection"
import { bindTimelineRows } from "../../src/pages/session/timeline/virtual-items"
import { TimelineRow } from "../../src/pages/session/timeline/timeline-row"
import { isContinuation, displayTurnOwners } from "@zaovra-ai/session-ui/turn-ownership"
import fixture from "./timeline811.json"

const id = "ses_e39859f8affe6TAAOAHHNBMDpX"
const messages = fixture.messages as unknown as SessionMessage[]
const info: SessionV2Info = {
  id,
  projectID: "fixture",
  title: "811",
  agent: "build",
  model: { id: "fixture", providerID: "fixture" },
  location: { directory: "/fixture" },
  time: { created: 1, updated: 1 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

function setup() {
  const state = { history: messages, requests: [] as { limit: number; cursor?: string }[] }
  const client = {
    v2: {
      session: {
        get: async () => ({ data: { data: info } }),
        pendingInputs: async () => ({ data: { data: [] } }),
        wait: () => new Promise(() => {}),
        messages: async (input: { limit: number; cursor?: string }) => {
          state.requests.push(input)
          const end = input.cursor ? Number(input.cursor) : state.history.length
          const start = Math.max(0, end - input.limit)
          return {
            data: {
              data: state.history.slice(start, end).toReversed(),
              cursor: { next: start ? String(start) : undefined },
            },
          }
        },
      },
    },
  } as unknown as ZaovraClient
  return { state, store: createServerSession(client) }
}

test("814 cold 47-message DB history crosses shell-only pages to the latest human turn", async () => {
  const ctx = setup()
  expect(messages.length).toBe(47)
  expect(messages.slice(-20).some((message) => message.type === "user")).toBe(false)
  await ctx.store.sync(id)
  expect(ctx.state.requests.length).toBe(3)
  expect(ctx.state.requests.map((request) => request.limit)).toEqual([20, 20, 20])
  const human = messages.findLast((message) => message.type === "user")!
  expect(ctx.store.data.message[id].some((message) => message.id === human.id)).toBe(true)
  const owners = displayTurnOwners(ctx.store.data.message[id], (key) => ctx.store.data.part[key] ?? [])
  expect(owners.get(human.id)).toBe(human.id)
  const shell = messages.findLast((message) => message.type === "shell")!
  expect(isContinuation(ctx.store.data.part[shell.id])).toBe(true)
  expect(owners.get(shell.id)).toBe(human.id)
  expect(ctx.store.history.complete(id)).toBe(true)
  ctx.store.evict(id)
})

for (const type of ["shell", "synthetic"] as const)
  test(`814 cached ${type} cannot stop paging before a real user`, async () => {
    const ctx = setup()
    ctx.state.history =
      type === "shell"
        ? [{ id: "shell", type, command: "echo fixture", output: "fixture", time: { created: 2, completed: 3 } }]
        : [{ id: "synthetic", type, text: "fixture", time: { created: 2 } }]
    await ctx.store.sync(id)
    const continuation = ctx.state.history[0]
    ctx.state.history = [
      { id: "human", type: "user", text: "fixture", time: { created: 1 } },
      continuation,
      ...Array.from(
        { length: 20 },
        (_, index): SessionMessage => ({
          id: `assistant:${index}`,
          type: "assistant",
          agent: "build",
          model: info.model!,
          time: { created: index + 4, completed: index + 5 },
          content: [{ id: "text", type: "text", text: "fixture" }],
        }),
      ),
    ]
    await ctx.store.sync(id, { force: true })
    expect(ctx.state.requests.length).toBe(3)
    expect(ctx.store.data.message[id].some((message) => message.id === "human")).toBe(true)
    expect(ctx.store.data.message[id].find((message) => message.id === "assistant:19")).toMatchObject({
      parentID: continuation.id,
    })
    ctx.store.evict(id)
  })

test("813 recorded admission/delivery, file tools, Stop, continue and second-turn events keep paired rows", async () => {
  await createRoot(async (dispose) => {
    const ctx = setup()
    ctx.state.history = []
    await ctx.store.sync(id)
    const projection = createTimelineProjection({
      messages: () => ctx.store.data.message[id] ?? [],
      userMessages: () => (ctx.store.data.message[id] ?? []).filter((message) => message.role === "user"),
      parts: (key) => ctx.store.data.part[key] ?? [],
      status: () => ctx.store.data.session_status[id] ?? { type: "idle" },
      showReasoningSummaries: () => true,
      inlineComments: () => false,
      historyComplete: () => ctx.store.history.complete(id),
    })
    const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
      get count() {
        return projection.rows().length
      },
      get getItemKey() {
        const rows = projection.rows()
        return (index: number) => TimelineRow.key(rows[index])
      },
      getScrollElement: () => null,
      initialRect: { width: 720, height: 600 },
      estimateSize: () => 100,
      overscan: 2,
      scrollToFn: () => {},
      observeElementRect: () => {},
      observeElementOffset: () => {},
    })
    const paired = createMemo(
      (previous) => bindTimelineRows(virtualizer.getVirtualItems(), projection.rowByKey(), previous),
      new Map(),
    )
    const rendered = createComponent(For, {
      get each() {
        return [...paired().keys()]
      },
      children: (key: string) => {
        const first = paired().get(key)!
        return () => (paired().get(key) ?? first).row._tag
      },
    }) as unknown as () => (() => string)[]
    createComputed(() => rendered().forEach((row) => expect(row()).toBeDefined()))
    const checkpoints = [414, 440, 520, 549]
    const counts: number[] = []
    for (const event of fixture.events) {
      batch(() => {
        ctx.store.apply({ type: event.type, properties: event.properties } as unknown as Event)
        const item = virtualizer.getVirtualItems()[0]
        if (item) virtualizer.resizeItem(item.index, 110)
        rendered().forEach((row) => expect(row()).toBeDefined())
      })
      if (!checkpoints.includes(event.seq)) continue
      ctx.state.history = fixture.history
        .filter((item) => item.seq <= event.seq)
        .map((item) => item.message) as unknown as SessionMessage[]
      await ctx.store.sync(id, { force: true })
      counts.push(projection.rows().length)
      expect(paired().size).toBeGreaterThan(0)
      expect([...paired()].every(([key, entry]) => TimelineRow.key(entry.row) === key && entry.item.key === key)).toBe(
        true,
      )
    }
    expect(fixture.events.filter((event) => event.type === "session.next.prompted").length).toBe(5)
    expect(fixture.events.some((event) => event.seq === 548 && event.type === "session.next.step.failed")).toBe(true)
    expect(counts.length).toBe(4)
    expect(
      ctx.store.data.message[id].some(
        (message) => message.id === fixture.events.find((event) => event.seq === 522)!.properties.messageID,
      ),
    ).toBe(true)
    ctx.store.apply({ type: "session.status", properties: { sessionID: id, status: { type: "idle" } } })
    ctx.store.evict(id)
    dispose()
  })
})
