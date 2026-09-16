import { describe, expect, test } from "bun:test"
import type { SessionInputAdmitted, ZaovraClient, SessionMessage, SessionV2Info } from "@zaovra-ai/sdk/v2/client"
import { createServerSession } from "./server-session"

const info = (id: string, parentID?: string): SessionV2Info => ({
  id,
  parentID,
  projectID: "project",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  title: id,
  location: { directory: "/repo" },
})

function setup(input: {
  sessions?: Record<string, SessionV2Info>
  pages?: { data: SessionMessage[]; cursor?: string }[]
  pending?: SessionInputAdmitted[]
  wait?: () => Promise<void>
  active?: () => Partial<Record<string, { type: "running" }>>
  pageWait?: () => Promise<void>
}) {
  const sessions = input.sessions ?? { ses_child: info("ses_child") }
  const pages = input.pages ?? [{ data: [] }]
  const requests = {
    get: [] as string[],
    messages: [] as { sessionID: string; cursor?: string }[],
    pending: [] as string[],
    limits: [] as number[],
  }
  const client = {
    v2: {
      session: {
        wait: input.wait ?? (() => Promise.resolve()),
        active: async () => ({ data: { data: input.active?.() ?? {} } }),
        get: async ({ sessionID }: { sessionID: string }) => {
          requests.get.push(sessionID)
          return { data: { data: sessions[sessionID] } }
        },
        messages: async ({ sessionID, cursor, limit }: { sessionID: string; cursor?: string; limit: number }) => {
          requests.messages.push({ sessionID, cursor })
          requests.limits.push(limit)
          if (limit < 1 || limit > 100) throw new Error("History limit must be between 1 and 100")
          const page = pages.shift() ?? { data: [] }
          await input.pageWait?.()
          return { data: { data: page.data, cursor: { next: page.cursor } } }
        },
        pendingInputs: async ({ sessionID }: { sessionID: string }) => {
          requests.pending.push(sessionID)
          return { data: { data: input.pending ?? [] } }
        },
      },
    },
    session: {
      diff: async () => ({ data: [] }),
      todo: async () => ({ data: [] }),
    },
  } as unknown as ZaovraClient
  return { store: createServerSession(client), requests }
}

const user = (id: string, text: string, created: number): SessionMessage => ({
  id,
  type: "user",
  text,
  time: { created },
})

const assistant = (id: string, text: string, created: number): Extract<SessionMessage, { type: "assistant" }> => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [{ id: `${id}:text`, type: "text", text }],
  time: { created, completed: created + 1 },
})

describe("V2 server session store", () => {
  test("reconciles the completed transcript when all completion events are missed", async () => {
    const initial = { ...assistant("msg_answer", "", 2), time: { created: 2 } }
    const completed = { ...assistant("msg_answer", "READY", 2), finish: "stop" as const }
    const ctx = setup({
      pages: [{ data: [initial, user("msg_user", "hello", 1)] }, { data: [completed, user("msg_user", "hello", 1)] }],
    })
    await ctx.store.sync("ses_child")
    ctx.store.set("session_status", "ses_child", { type: "busy" })
    await ctx.store.watchExecution("ses_child")
    expect(ctx.store.data.session_working("ses_child")).toBe(false)
    expect(ctx.store.data.part.msg_answer[0]).toMatchObject({ text: "READY" })
    expect(ctx.store.data.message.ses_child.find((m) => m.id === "msg_answer")?.time).toMatchObject({ completed: 3 })
  })
  test("distinguishes backend-confirmed history from an unacknowledged optimistic message", async () => {
    const ctx = setup({ pages: [{ data: [user("msg_persisted", "Already sent", 1)] }] })
    await ctx.store.sync("ses_child")
    expect(ctx.store.messageConfirmed("ses_child", "msg_persisted")).toBe(true)
    expect(ctx.store.messageConfirmed("ses_other", "msg_persisted")).toBe(false)
    const message = {
      id: "msg_pending",
      sessionID: "ses_child",
      role: "user" as const,
      time: { created: 2 },
      agent: "build",
      model: { modelID: "model", providerID: "provider" },
    }
    ctx.store.optimistic.add({ sessionID: "ses_child", message, parts: [] })
    expect(ctx.store.messageConfirmed("ses_child", "msg_pending")).toBe(false)
    ctx.store.apply({ type: "message.updated", properties: { info: message } })
    expect(ctx.store.messageConfirmed("ses_child", "msg_pending")).toBe(true)
  })
  test("merges offset deltas arriving during an older snapshot read", async () => {
    const entered = Promise.withResolvers<void>()
    const returned = Promise.withResolvers<void>()
    const ctx = setup({
      pages: [
        { data: [assistant("msg_first", "hello", 1), user("msg_user", "question", 0)] },
        { data: [assistant("msg_first", "hello wo", 1), user("msg_user", "question", 0)] },
      ],
      pageWait: () => {
        if (ctx.requests.messages.length < 2) return Promise.resolve()
        entered.resolve()
        return returned.promise
      },
    })
    await ctx.store.sync("ses_child")
    const reading = ctx.store.sync("ses_child", { force: true })
    await entered.promise
    ctx.store.apply({
      type: "session.next.text.delta",
      properties: {
        sessionID: "ses_child",
        assistantMessageID: "msg_first",
        textID: "msg_first:text",
        offset: 5,
        delta: " world",
      },
    })
    returned.resolve()
    await reading
    expect(ctx.store.data.part["msg_first"]?.[0]).toMatchObject({ text: "hello world" })
  })

  test("retains a delta received before the snapshot supplies its missing prefix", async () => {
    const entered = Promise.withResolvers<void>()
    const returned = Promise.withResolvers<void>()
    const ctx = setup({
      pages: [{ data: [assistant("msg_first", "hello", 1), user("msg_user", "question", 0)] }],
      pageWait: () => {
        entered.resolve()
        return returned.promise
      },
    })
    const reading = ctx.store.sync("ses_child")
    await entered.promise
    ctx.store.apply({
      type: "session.next.text.delta",
      properties: {
        sessionID: "ses_child",
        assistantMessageID: "msg_first",
        textID: "msg_first:text",
        offset: 5,
        delta: " world",
      },
    })
    returned.resolve()
    await reading
    expect(ctx.store.data.part["msg_first"]?.[0]).toMatchObject({ text: "hello world" })
  })
  test("does not append an in-flight delta already included in the active snapshot", async () => {
    const ctx = setup({
      pages: [{ data: [assistant("msg_first", "hello world", 1), user("msg_user", "question", 0)] }],
    })
    await ctx.store.sync("ses_child")
    ctx.store.apply({
      type: "session.next.text.started",
      properties: { sessionID: "ses_child", assistantMessageID: "msg_first", textID: "msg_first:text", timestamp: 1 },
    })
    ctx.store.apply({
      type: "session.next.text.delta",
      properties: {
        sessionID: "ses_child",
        assistantMessageID: "msg_first",
        textID: "msg_first:text",
        offset: 5,
        delta: " world",
      },
    })
    expect(ctx.store.data.part["msg_first"]?.[0]).toMatchObject({ text: "hello world" })
  })
  test("isolates repeated provider text IDs across historical and streaming messages", async () => {
    const first: SessionMessage = {
      ...assistant("msg_first", "History stays unchanged", 1),
      content: [{ id: "text-0", type: "text", text: "History stays unchanged" }],
    }
    const second: SessionMessage = {
      ...assistant("msg_second", "", 3),
      content: [{ id: "text-0", type: "text", text: "" }],
    }
    const ctx = setup({ pages: [{ data: [second, first, user("msg_user", "question", 0)] }] })
    await ctx.store.sync("ses_child")
    const oldPart = ctx.store.data.part.msg_first[0]
    const newPart = ctx.store.data.part.msg_second[0]
    expect(oldPart.id).not.toBe(newPart.id)
    ctx.store.apply({
      type: "session.next.text.delta",
      properties: { sessionID: "ses_child", assistantMessageID: "msg_second", textID: "text-0", delta: "New response" },
    })
    expect(ctx.store.data.part_text_accum_delta[oldPart.id]).toBeUndefined()
    expect(ctx.store.data.part_text_accum_delta[newPart.id]).toBe("New response")
    expect(ctx.store.data.part.msg_first).toMatchObject([{ text: "History stays unchanged" }])
  })
  test("refreshes a new empty session with an admissible history page size", async () => {
    const ctx = setup({
      pages: [{ data: [] }, { data: [assistant("msg_002", "answer", 2), user("msg_001", "question", 1)] }],
    })
    await ctx.store.sync("ses_child")
    await ctx.store.sync("ses_child", { force: true })
    expect(ctx.store.data.part.msg_002).toMatchObject([{ type: "text", text: "answer" }])
    expect(ctx.requests.limits).toEqual([20, 20])
  })

  test("caps history requests after more than one hundred messages are cached", async () => {
    const ctx = setup({
      pages: [
        {
          data: Array.from({ length: 100 }, (_, index) => user(`msg_${100 + index}`, "new", 100 + index)),
          cursor: "older",
        },
        { data: Array.from({ length: 20 }, (_, index) => user(`msg_${index}`, "old", index)) },
        { data: [user("msg_200", "newest", 200)], cursor: "older" },
      ],
    })
    await ctx.store.sync("ses_child", { messageLimit: 100 })
    await ctx.store.history.loadMore("ses_child")
    expect(ctx.store.data.message.ses_child).toHaveLength(120)
    await ctx.store.sync("ses_child", { force: true })
    expect(ctx.requests.limits.at(-1)).toBe(100)
    expect(ctx.store.data.message.ses_child.some((message) => message.id === "msg_200")).toBe(true)
  })

  test("keeps a split turn until older pagination supplies its user", async () => {
    const ctx = setup({
      pages: [
        {
          data: [
            assistant("msg_004", "new answer", 4),
            user("msg_003", "new", 3),
            assistant("msg_002", "old answer", 2),
          ],
          cursor: "older",
        },
        { data: [user("msg_001", "old", 1)] },
      ],
    })
    await ctx.store.sync("ses_child")
    await ctx.store.history.loadMore("ses_child")
    expect(ctx.store.data.message.ses_child.map((message) => message.id)).toEqual([
      "msg_001",
      "msg_002",
      "msg_003",
      "msg_004",
    ])
    expect(ctx.store.data.message.ses_child.find((message) => message.id === "msg_002")).toMatchObject({
      parentID: "msg_001",
    })
  })

  test("never assigns older output to a newer cached user while paginating", async () => {
    const ctx = setup({
      pages: [
        { data: [assistant("msg_004", "new answer", 4), user("msg_003", "new", 3)], cursor: "older" },
        { data: [assistant("msg_002", "old answer", 2)], cursor: "oldest" },
        { data: [user("msg_001", "old", 1)] },
      ],
    })
    await ctx.store.sync("ses_child")
    await ctx.store.history.loadMore("ses_child")
    expect(ctx.requests.messages.length).toBe(3)
    expect(ctx.store.data.message.ses_child.find((message) => message.id === "msg_002")).toMatchObject({
      parentID: "msg_001",
    })
  })

  test("restores queued inputs separately without inventing a visible user turn", async () => {
    const ctx = setup({
      pending: [
        {
          admittedSeq: 1,
          id: "msg_queue",
          sessionID: "ses_child",
          prompt: { text: "Later" },
          delivery: "queue",
          timeCreated: 2,
        },
      ],
    })
    await ctx.store.sync("ses_child")
    expect(ctx.store.data.pending_input.ses_child[0].id).toBe("msg_queue")
    expect(ctx.store.data.message.ses_child.length).toBe(0)
    ctx.store.apply({
      type: "session.next.prompted",
      properties: {
        sessionID: "ses_child",
        messageID: "msg_queue",
        timestamp: 2,
        prompt: { text: "Later" },
        delivery: "queue",
      },
    })
    expect(ctx.store.data.pending_input.ses_child.length).toBe(0)
    expect(ctx.store.data.message.ses_child[0].id).toBe("msg_queue")
  })

  test("a provider step ending does not mark a continuing drain idle", async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const waits = [first, second]
    const ctx = setup({
      wait: () => {
        if (waits.length === 1) started.resolve()
        return waits.shift()!.promise
      },
      active: () => (waits.length === 0 ? {} : { ses_child: { type: "running" } }),
    })
    await ctx.store.resolve("ses_child")
    ctx.store.set("session_status", "ses_child", { type: "busy" })
    ctx.store.apply({
      type: "session.next.step.ended",
      properties: { sessionID: "ses_child", assistantMessageID: "msg_2", timestamp: 2, finish: "tool-calls" },
    })
    const settled = ctx.store.watchExecution("ses_child")
    expect(ctx.store.data.session_working("ses_child")).toBe(true)
    first.resolve()
    await started.promise
    expect(ctx.store.data.session_working("ses_child")).toBe(true)
    second.resolve()
    await settled
    expect(ctx.store.data.session_working("ses_child")).toBe(false)
  })

  test("a failed wait cannot claim idle while the server still owns execution", async () => {
    const ctx = setup({
      wait: () => Promise.reject(new Error("disconnected")),
      active: () => ({ ses_child: { type: "running" } }),
    })
    await ctx.store.resolve("ses_child")
    ctx.store.set("session_status", "ses_child", { type: "busy" })
    await expect(ctx.store.watchExecution("ses_child")).rejects.toThrow("disconnected")
    expect(ctx.store.data.session_working("ses_child")).toBe(true)
  })

  test("retains the latest output when finding its user requires more than four pages", async () => {
    const ctx = setup({
      pages: [
        ...Array.from({ length: 5 }, (_, page) => ({
          data: [assistant(`msg_${6 - page}`, `output ${page}`, 6 - page)],
          cursor: `cursor_${page}`,
        })),
        { data: [user("msg_1", "long task", 1)] },
      ],
    })
    await ctx.store.sync("ses_child")
    expect(ctx.store.data.message.ses_child.map((message) => message.id)).toEqual([
      "msg_1",
      "msg_2",
      "msg_3",
      "msg_4",
      "msg_5",
      "msg_6",
    ])
    expect(ctx.store.data.message.ses_child[5]).toMatchObject({ parentID: "msg_1" })
  })

  test("retains the durable revert boundary on cold resolution", async () => {
    const ctx = setup({
      sessions: { ses_child: { ...info("ses_child"), revert: { messageID: "msg_2", snapshot: "snapshot" } } },
    })
    await ctx.store.resolve("ses_child")
    expect(ctx.store.get("ses_child")?.revert).toEqual({ messageID: "msg_2", snapshot: "snapshot" })
  })

  test("resolves parent lineage only through V2 Session", async () => {
    const ctx = setup({ sessions: { ses_child: info("ses_child", "ses_root"), ses_root: info("ses_root") } })

    const result = await ctx.store.lineage.resolve("ses_child")

    expect(result.root.id).toBe("ses_root")
    expect(ctx.store.get("ses_child")?.model).toEqual({ id: "model", providerID: "provider" })
    expect(ctx.requests.get).toEqual(["ses_child", "ses_root"])
  })

  test("loads and adapts V2 messages into the desktop timeline", async () => {
    const ctx = setup({ pages: [{ data: [assistant("msg_002", "answer", 2), user("msg_001", "question", 1)] }] })

    await ctx.store.sync("ses_child")

    expect(ctx.store.data.message.ses_child.map((message) => message.id)).toEqual(["msg_001", "msg_002"])
    expect(ctx.store.data.message.ses_child[1]).toMatchObject({ role: "assistant", parentID: "msg_001" })
    expect(ctx.store.data.part.msg_002).toMatchObject([{ type: "text", text: "answer" }])
  })

  test("restores durably admitted inputs that have not entered the transcript", async () => {
    const ctx = setup({
      pending: [
        {
          admittedSeq: 2,
          id: "msg_pending",
          sessionID: "ses_child",
          prompt: { text: "new requirement" },
          delivery: "steer",
          timeCreated: 3,
        },
      ],
    })

    await ctx.store.sync("ses_child")

    expect(ctx.requests.pending).toEqual(["ses_child"])
    expect(ctx.store.data.message.ses_child).toMatchObject([{ id: "msg_pending", role: "user" }])
    expect(ctx.store.data.part.msg_pending).toMatchObject([{ type: "text", text: "new requirement" }])
  })

  test("uses the opaque V2 cursor to prepend older history", async () => {
    const ctx = setup({
      pages: [
        { data: [assistant("msg_004", "new answer", 4), user("msg_003", "new", 3)], cursor: "older" },
        { data: [assistant("msg_002", "old answer", 2), user("msg_001", "old", 1)] },
      ],
    })
    await ctx.store.sync("ses_child")

    await ctx.store.history.loadMore("ses_child")

    expect(ctx.requests.messages).toEqual([
      { sessionID: "ses_child", cursor: undefined },
      { sessionID: "ses_child", cursor: "older" },
    ])
    expect(ctx.store.data.message.ses_child.map((message) => message.id)).toEqual([
      "msg_001",
      "msg_002",
      "msg_003",
      "msg_004",
    ])
  })

  test("shows a V2 provider retry and clears it when model output starts", async () => {
    const finished = Promise.withResolvers<void>()
    const ctx = setup({ wait: () => finished.promise })
    await ctx.store.sync("ses_child")
    ctx.store.apply({
      type: "session.next.retried",
      properties: {
        sessionID: "ses_child",
        timestamp: 1000,
        attempt: 2,
        error: { message: "Retrying provider", isRetryable: true, metadata: { delayMs: "2000" } },
      },
    })
    expect(ctx.store.data.session_status.ses_child).toEqual({
      type: "retry",
      attempt: 2,
      message: "Retrying provider",
      next: 3000,
    })
    ctx.store.apply({
      type: "session.next.step.started",
      properties: {
        sessionID: "ses_child",
        timestamp: 3100,
        assistantMessageID: "msg_retry",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    expect(ctx.store.data.session_status.ses_child).toEqual({ type: "busy" })
    finished.resolve()
  })

  test("promotes a durable V2 prompt without waiting for a legacy message event", () => {
    const ctx = setup({})
    ctx.store.remember({
      id: "ses_child",
      slug: "ses_child",
      projectID: "project",
      directory: "/repo",
      title: "child",
      version: "",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      time: { created: 1, updated: 1 },
    })

    ctx.store.apply({
      type: "session.next.prompted",
      properties: {
        timestamp: 2,
        sessionID: "ses_child",
        messageID: "msg_001",
        prompt: { text: "new requirement" },
        delivery: "steer",
      },
    })

    expect(ctx.store.data.message.ses_child).toMatchObject([{ id: "msg_001", role: "user" }])
    expect(ctx.store.data.part.msg_001).toMatchObject([{ type: "text", text: "new requirement" }])
    expect(ctx.store.data.session_status.ses_child).toEqual({ type: "busy" })
  })

  test("shows a durable V2 prompt as soon as it is admitted", () => {
    const ctx = setup({})
    ctx.store.remember({
      id: "ses_child",
      slug: "ses_child",
      projectID: "project",
      directory: "/repo",
      title: "child",
      version: "",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      time: { created: 1, updated: 1 },
    })

    ctx.store.apply({
      type: "session.next.prompt.admitted",
      properties: {
        timestamp: 2,
        sessionID: "ses_child",
        messageID: "msg_001",
        prompt: { text: "new requirement" },
        delivery: "steer",
      },
    })

    expect(ctx.store.data.message.ses_child).toMatchObject([{ id: "msg_001", role: "user" }])
    expect(ctx.store.data.part.msg_001).toMatchObject([{ type: "text", text: "new requirement" }])
  })

  test("streams V2 assistant text deltas into the existing timeline state", () => {
    const ctx = setup({})
    ctx.store.remember({
      id: "ses_child",
      slug: "ses_child",
      projectID: "project",
      directory: "/repo",
      title: "child",
      version: "",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      time: { created: 1, updated: 1 },
    })
    ctx.store.apply({
      type: "session.next.prompted",
      properties: {
        timestamp: 1,
        sessionID: "ses_child",
        messageID: "msg_001",
        prompt: { text: "question" },
      },
    })
    ctx.store.apply({
      type: "session.next.step.started",
      properties: {
        timestamp: 2,
        sessionID: "ses_child",
        assistantMessageID: "msg_002",
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    ctx.store.apply({
      type: "session.next.text.started",
      properties: {
        timestamp: 3,
        sessionID: "ses_child",
        assistantMessageID: "msg_002",
        textID: "text_1",
      },
    })
    ctx.store.apply({
      type: "session.next.text.delta",
      properties: {
        sessionID: "ses_child",
        assistantMessageID: "msg_002",
        textID: "text_1",
        delta: "hello",
      },
    })

    expect(ctx.store.data.message.ses_child[1]).toMatchObject({ id: "msg_002", parentID: "msg_001" })
    expect(ctx.store.data.part.msg_002).toMatchObject([{ id: "msg_002:text_1", text: "hello" }])
  })
})
