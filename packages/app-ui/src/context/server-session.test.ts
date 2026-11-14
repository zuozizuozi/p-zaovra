import { describe, expect, test } from "bun:test"
import { unwrap } from "solid-js/store"
import type {
  QuestionView,
  SessionInputAdmitted,
  ZaovraClient,
  SessionMessage,
  SessionV2Info,
} from "@zaovra-ai/sdk/v2/client"
import { createServerSession } from "./server-session"
import { quietToolFailures } from "@zaovra-ai/session-ui/tool-recovery"

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
  pendingWait?: () => Promise<void>
  wait?: () => Promise<void>
  active?: () => Partial<Record<string, { type: "running" }>>
  interrupt?: () => Promise<void>
  pageWait?: () => Promise<void>
  getWait?: () => Promise<void>
  questions?: () => Promise<QuestionView[]>
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
      question: { request: { list: async () => ({ data: { data: (await input.questions?.()) ?? [] } }) } },
      permission: { request: { list: async () => ({ data: { data: [] } }) } },
      session: {
        interrupt: input.interrupt ?? (() => Promise.resolve()),
        wait: input.wait ?? (() => Promise.resolve()),
        active: async () => ({ data: { data: input.active?.() ?? {} } }),
        get: async ({ sessionID }: { sessionID: string }) => {
          requests.get.push(sessionID)
          const session = sessions[sessionID]
          await input.getWait?.()
          return { data: { data: session } }
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
          await input.pendingWait?.()
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

test("177 source order survives ID lookup, deltas, removal and history reload", async () => {
  const message = assistant("msg_answer", "", 2)
  message.content = [
    { type: "reasoning", id: "reasoning-0", text: "Think" },
    { type: "text", id: "text-0", text: "Before tool" },
    {
      type: "tool",
      id: "call-z",
      name: "read",
      time: { created: 2, completed: 3 },
      state: { status: "completed", input: {}, content: [{ type: "text", text: "Result" }], structured: {} },
    },
    ...Array.from({ length: 12 }, (_, index) => ({
      type: "text" as const,
      id: `text-${index + 1}`,
      text: `After ${index + 1}`,
    })),
  ]
  const ctx = setup({
    pages: [{ data: [user("msg_user", "Read", 1), message] }, { data: [user("msg_user", "Read", 1), message] }],
  })
  await ctx.store.sync("ses_child")
  const ids = message.content.map((part) => `msg_answer:${part.id}`)
  expect(ctx.store.data.part.msg_answer.map((part) => part.id)).toEqual(ids)
  ctx.store.apply({
    type: "message.part.delta",
    properties: {
      sessionID: "ses_child",
      messageID: "msg_answer",
      partID: "msg_answer:text-10",
      field: "text",
      delta: " appended",
    },
  })
  expect(unwrap(ctx.store.data.part.msg_answer.find((part) => part.id === "msg_answer:text-10"))).toMatchObject({
    text: "After 10 appended",
  })
  ctx.store.apply({
    type: "message.part.removed",
    properties: { sessionID: "ses_child", messageID: "msg_answer", partID: "msg_answer:call-z" },
  })
  expect(ctx.store.data.part.msg_answer.map((part) => part.id)).toEqual(ids.filter((id) => id !== "msg_answer:call-z"))
  await ctx.store.sync("ses_child", { force: true })
  expect(ctx.store.data.part.msg_answer.map((part) => part.id)).toEqual(ids.filter((id) => id !== "msg_answer:call-z"))
})

for (const continuation of ["继续", "continue", "补充要求", "修改要求"])
  test("request evidence stays conservative through real store pagination and reopen: " + continuation, async () => {
    const original = user("msg_001", "必须先读 customer-spec.md，缺失不得自编。", 1)
    const current: Extract<SessionMessage, { type: "user" }> = {
      id: "msg_003",
      type: "user",
      text: continuation,
      time: { created: 3 },
    }
    const failed: Extract<SessionMessage, { type: "assistant" }> = {
      ...assistant("msg_004", "", 4),
      finish: "tool-calls",
      content: [
        {
          id: "read",
          type: "tool",
          name: "read",
          time: { created: 4, completed: 5 },
          state: {
            status: "error",
            input: { path: "customer-spec.md" },
            content: [],
            structured: {},
            error: {
              type: "unknown",
              message: "Unable to read customer-spec.md",
              metadata: { readFailure: "not_found" },
            },
          },
        },
      ],
    }
    const final: Extract<SessionMessage, { type: "assistant" }> = {
      ...assistant("msg_006", "已完成", 6),
      finish: "stop",
      content: [
        {
          id: "write",
          type: "tool",
          name: "write",
          time: { created: 6, completed: 7 },
          state: {
            status: "completed",
            input: { path: "customer-spec.md", content: "placeholder" },
            content: [],
            structured: {},
          },
        },
        { id: "answer", type: "text", text: "已完成" },
      ],
    }
    const recent = [final, failed, current]
    const before = JSON.stringify([original, ...recent])
    const check = (ctx: ReturnType<typeof setup>) => {
      const message = ctx.store.data.message.ses_child.find((item) => item.id === final.id)
      if (message?.role !== "assistant") throw Error("Missing actual adapted assistant")
      return quietToolFailures({
        message,
        messages: ctx.store.data.message.ses_child,
        parts: ctx.store.data.part,
        working: false,
        historyComplete: ctx.store.history.complete("ses_child"),
      })
    }
    const ctx = setup({ pages: [{ data: recent, cursor: "older" }, { data: [original] }] })
    expect(ctx.store.history.complete("ses_child")).toBe(false)
    await ctx.store.sync("ses_child")
    expect(ctx.store.history.more("ses_child")).toBe(true)
    expect(check(ctx)).toEqual([])
    expect(ctx.requests.messages.length).toBe(1)
    await ctx.store.history.loadMore("ses_child")
    expect(ctx.store.history.complete("ses_child")).toBe(true)
    expect(check(ctx)).toEqual([])
    expect(ctx.requests.messages.length).toBe(2)
    const reopened = setup({ pages: [{ data: recent, cursor: "older" }] })
    await reopened.store.sync("ses_child")
    expect(reopened.store.history.complete("ses_child")).toBe(false)
    expect(check(reopened)).toEqual([])
    expect(reopened.requests.messages.length).toBe(1)
    const fresh = setup({ pages: [{ data: [final, failed, { ...current, text: "做个小游戏" }], cursor: "older" }] })
    await fresh.store.sync("ses_child")
    expect(check(fresh).map((part) => part.id)).toEqual([`${failed.id}:read`])
    expect(JSON.stringify([original, ...recent])).toBe(before)
  })

describe("V2 server session store", () => {
  test("host completion events reconcile as synthetic history without a transient user prompt", async () => {
    const completion = { type: "bash-completion" as const, sourceMessageID: "msg_user", jobID: "job_task" }
    const entered = Promise.withResolvers<void>()
    const returned = Promise.withResolvers<void>()
    const ctx = setup({
      pages: [
        { data: [user("msg_user", "Original task", 1)] },
        {
          data: [
            {
              id: "msg_host",
              type: "synthetic",
              sessionID: "ses_child",
              text: "Task completed",
              completion,
              time: { created: 2 },
            },
            user("msg_user", "Original task", 1),
          ],
        },
      ],
      pageWait: () => {
        if (ctx.requests.messages.length < 2) return Promise.resolve()
        entered.resolve()
        return returned.promise
      },
    })
    await ctx.store.sync("ses_child")
    ctx.store.apply({
      type: "session.next.prompted",
      properties: {
        sessionID: "ses_child",
        messageID: "msg_host",
        timestamp: 2,
        prompt: { text: "Task completed" },
        delivery: "queue",
        completion,
      },
    })
    expect(ctx.store.data.message.ses_child.map((item) => item.id)).toEqual(["msg_user"])
    await entered.promise
    expect(ctx.store.data.part.msg_host).toBeUndefined()
    returned.resolve()
    for (let index = 0; index < 50 && !ctx.store.data.part.msg_host; index++) await Bun.sleep(10)
    expect(unwrap(ctx.store.data.part.msg_host)).toMatchObject([{ text: "Task completed", synthetic: true }])
    expect(unwrap(ctx.store.data.part.msg_user)).toMatchObject([{ text: "Original task" }])
  })

  test("a late provider start during final history reconciliation is checked again", async () => {
    const page = Promise.withResolvers<void>()
    const loading = Promise.withResolvers<void>()
    let waits = 0
    const ctx = setup({
      wait: async () => {
        waits++
      },
      pageWait: () => {
        loading.resolve()
        return page.promise
      },
    })
    await ctx.store.resolve("ses_child")
    ctx.store.set("session_status", "ses_child", { type: "busy" })
    const watching = ctx.store.watchExecution("ses_child")
    await loading.promise
    ctx.store.apply({
      type: "session.next.step.started",
      properties: {
        sessionID: "ses_child",
        assistantMessageID: "late",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        timestamp: 2,
      },
    })
    page.resolve()
    await watching
    expect(waits).toBe(2)
    expect(ctx.store.data.session_working("ses_child")).toBe(false)
  })
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
    expect(unwrap(ctx.store.data.part.msg_answer[0])).toMatchObject({ text: "READY" })
    expect(unwrap(ctx.store.data.message.ses_child.find((m) => m.id === "msg_answer")?.time)).toMatchObject({
      completed: 3,
    })
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
    expect(unwrap(ctx.store.data.part["msg_first"]?.[0])).toMatchObject({ text: "hello world" })
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
    expect(unwrap(ctx.store.data.part["msg_first"]?.[0])).toMatchObject({ text: "hello world" })
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
    expect(unwrap(ctx.store.data.part["msg_first"]?.[0])).toMatchObject({ text: "hello world" })
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
    expect(unwrap(ctx.store.data.part.msg_first)).toMatchObject([{ text: "History stays unchanged" }])
  })
  test("refreshes a new empty session with an admissible history page size", async () => {
    const ctx = setup({
      pages: [{ data: [] }, { data: [assistant("msg_002", "answer", 2), user("msg_001", "question", 1)] }],
    })
    await ctx.store.sync("ses_child")
    await ctx.store.sync("ses_child", { force: true })
    expect(unwrap(ctx.store.data.part.msg_002)).toMatchObject([{ type: "text", text: "answer" }])
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
    expect(unwrap(ctx.store.data.message.ses_child.find((message) => message.id === "msg_002"))).toMatchObject({
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
    expect(unwrap(ctx.store.data.message.ses_child.find((message) => message.id === "msg_002"))).toMatchObject({
      parentID: "msg_001",
    })
  })

  test("701 restores queued inputs as visible pending bubbles before promotion", async () => {
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
    expect(ctx.store.data.message.ses_child).toHaveLength(1)
    expect(unwrap(ctx.store.data.part.msg_queue)).toMatchObject([{ metadata: { zaovraDelivery: "queue" } }])
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
    expect(unwrap(ctx.store.data.message.ses_child[5])).toMatchObject({ parentID: "msg_1" })
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
    expect(unwrap(ctx.store.data.message.ses_child[1])).toMatchObject({ role: "assistant", parentID: "msg_001" })
    expect(unwrap(ctx.store.data.part.msg_002)).toMatchObject([{ type: "text", text: "answer" }])
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
    expect(unwrap(ctx.store.data.message.ses_child)).toMatchObject([{ id: "msg_pending", role: "user" }])
    expect(unwrap(ctx.store.data.part.msg_pending)).toMatchObject([{ type: "text", text: "new requirement" }])
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

    expect(unwrap(ctx.store.data.message.ses_child)).toMatchObject([{ id: "msg_001", role: "user" }])
    expect(unwrap(ctx.store.data.part.msg_001)).toMatchObject([{ type: "text", text: "new requirement" }])
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

    expect(unwrap(ctx.store.data.message.ses_child)).toMatchObject([{ id: "msg_001", role: "user" }])
    expect(unwrap(ctx.store.data.part.msg_001)).toMatchObject([{ type: "text", text: "new requirement" }])
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

    expect(unwrap(ctx.store.data.message.ses_child[1])).toMatchObject({ id: "msg_002", parentID: "msg_001" })
    expect(unwrap(ctx.store.data.part.msg_002)).toMatchObject([{ id: "msg_002:text_1", text: "hello" }])
    ctx.store.apply({
      type: "session.next.text.ended",
      properties: {
        timestamp: 4,
        sessionID: "ses_child",
        assistantMessageID: "msg_002",
        textID: "text_1",
        text: "hello",
        superseded: true,
      },
    })
    expect(unwrap(ctx.store.data.part.msg_002)).toMatchObject([
      { text: "[被替代的未完成输出]\nhello", metadata: { superseded: true } },
    ])
  })
})

test("a recovery Synthetic event refreshes durable history while the session stays busy", async () => {
  const refreshed = Promise.withResolvers<void>()
  const ctx = setup({
    pages: [
      {
        data: [
          {
            type: "synthetic",
            id: "msg_recovery",
            sessionID: "ses_child",
            time: { created: 4 },
            text: "恢复记录：重试2次",
            recovery: { id: "msg_episode", started: 1, ended: 4, attempts: 2, phase: "recovered" },
          },
        ],
      },
    ],
    pageWait: () => {
      refreshed.resolve()
      return Promise.resolve()
    },
  })
  await ctx.store.resolve("ses_child")
  ctx.store.set("session_status", "ses_child", { type: "busy" })
  ctx.store.apply({
    type: "session.next.synthetic",
    properties: { sessionID: "ses_child", messageID: "msg_recovery", timestamp: 4, text: "恢复记录：重试2次" },
  })
  await refreshed.promise
  // Let the queued history response finish adapting into the same store.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(unwrap(ctx.store.data.part.msg_recovery)).toMatchObject([{ text: "恢复记录：重试2次" }])
  expect(ctx.store.data.session_working("ses_child")).toBe(true)
})

test("Stop wait settling cannot clear the new task's busy state and its final tail is reconciled", async () => {
  const old = Promise.withResolvers<void>()
  const current = Promise.withResolvers<void>()
  const following = Promise.withResolvers<void>()
  const waits = [old, current]
  const ctx = setup({
    wait: () => {
      if (waits.length === 1) following.resolve()
      return waits.shift()!.promise
    },
    active: () => (waits.length === 0 ? {} : { ses_child: { type: "running" } }),
    pages: [{ data: [assistant("msg_new", "NEW_TAIL_中文🙂", 3), user("msg_new_input", "new task", 2)] }],
  })
  await ctx.store.resolve("ses_child")
  ctx.store.set("session_status", "ses_child", { type: "busy" })
  const watching = ctx.store.watchExecution("ses_child")
  old.resolve()
  await following.promise
  expect(ctx.store.data.session_working("ses_child")).toBe(true)
  current.resolve()
  await watching
  expect(ctx.store.data.session_working("ses_child")).toBe(false)
  expect(unwrap(ctx.store.data.part.msg_new[0])).toMatchObject({ text: "NEW_TAIL_中文🙂" })
})

test("shell liveness is connection-local and ends without waiting for history refresh", () => {
  const { store } = setup({})
  store.apply({
    type: "session.next.shell.started",
    properties: { sessionID: "ses_child", messageID: "job_live", callID: "job_live", command: "serve", timestamp: 1 },
  })
  expect(store.data.live_shell?.ses_child?.job_live).toBe(true)
  expect(store.data.live_shell?.ses_other?.job_live).toBeUndefined()
  store.apply({
    type: "session.next.shell.ended",
    properties: { sessionID: "ses_child", callID: "job_live", output: "", timestamp: 2 },
  })
  expect(store.data.live_shell?.ses_child?.job_live).toBeUndefined()
  store.apply({
    type: "session.next.shell.started",
    properties: { sessionID: "ses_child", messageID: "job_live", callID: "job_live", command: "serve", timestamp: 3 },
  })
  store.apply({ type: "server.connected" })
  expect(store.data.live_shell?.ses_child?.job_live).toBeUndefined()
  store.apply({
    type: "session.next.shell.started",
    properties: { sessionID: "ses_child", messageID: "job_live", callID: "job_live", command: "serve", timestamp: 4 },
  })
  store.apply({ type: "global.disposed" })
  expect(store.data.live_shell?.ses_child?.job_live).toBeUndefined()
})

test("732 Stop confirms idle from process ownership when execution events were missed", async () => {
  let activeCalls = 0
  const ctx = setup({
    pages: [{ data: [user("msg_first", "Task", 1)] }],
    active: () => {
      activeCalls++
      return {}
    },
  })
  await ctx.store.sync("ses_child")
  ctx.store.set("session_status", "ses_child", { type: "busy" })
  await ctx.store.interrupt("ses_child")
  const deadline = Date.now() + 2000
  while (ctx.store.data.session_working("ses_child") && Date.now() < deadline) await Bun.sleep(0)
  expect(activeCalls).toBeGreaterThan(0)
  expect(ctx.store.data.session_working("ses_child")).toBe(false)
})

test("732 Stop stays busy until process ownership can be confirmed idle", async () => {
  const owner = Promise.withResolvers<void>()
  const ctx = setup({ wait: () => owner.promise })
  await ctx.store.sync("ses_child")
  ctx.store.set("session_status", "ses_child", { type: "busy" })
  await ctx.store.interrupt("ses_child")
  expect(ctx.store.data.session_working("ses_child")).toBe(true)
  owner.resolve()
  const deadline = Date.now() + 2000
  while (ctx.store.data.session_working("ses_child") && Date.now() < deadline) await Bun.sleep(0)
  expect(ctx.store.data.session_working("ses_child")).toBe(false)
})

test("a confirmed Stop before any assistant belongs to the captured turn, not a later input", async () => {
  const gate = Promise.withResolvers<void>()
  const ctx = setup({ pages: [{ data: [user("msg_first", "Task", 1)] }], interrupt: () => gate.promise })
  await ctx.store.sync("ses_child")
  ctx.store.set("session_status", "ses_child", { type: "busy" })
  const stopping = ctx.store.interrupt("ses_child")
  ctx.store.apply({
    type: "message.updated",
    properties: {
      info: {
        ...ctx.store.data.message.ses_child[0],
        id: "msg_second",
        time: { created: 3 },
      },
    },
  })
  gate.resolve()
  await stopping
  expect(ctx.store.stopped("msg_first")).toBe(true)
  expect(ctx.store.stopped("msg_second")).toBe(false)
})

test("idle or failed Stop never invents a stopped turn", async () => {
  const ctx = setup({
    pages: [{ data: [user("msg_first", "Task", 1)] }],
    interrupt: async () => {
      throw Error("offline")
    },
  })
  await ctx.store.sync("ses_child")
  await expect(ctx.store.interrupt("ses_child")).rejects.toThrow("offline")
  expect(ctx.store.stopped("msg_first")).toBe(false)
  ctx.store.set("session_status", "ses_child", { type: "busy" })
  await expect(ctx.store.interrupt("ses_child")).rejects.toThrow("offline")
  expect(ctx.store.stopped("msg_first")).toBe(false)
})

test("a Stop receipt does not replace an existing assistant's interrupted result", async () => {
  const ctx = setup({
    pages: [
      { data: [user("msg_first", "Task", 1), { ...assistant("msg_answer", "Partial", 2), finish: "interrupted" }] },
    ],
  })
  await ctx.store.sync("ses_child")
  ctx.store.set("session_status", "ses_child", { type: "busy" })
  await ctx.store.interrupt("ses_child")
  expect(ctx.store.stopped("msg_first")).toBe(false)
})

test("an empty streaming assistant shell still counts as first-output Stop", async () => {
  const ctx = setup({ pages: [{ data: [user("msg_first", "Task", 1)] }] })
  await ctx.store.sync("ses_child")
  ctx.store.set("session_status", "ses_child", { type: "busy" })
  ctx.store.apply({
    type: "message.updated",
    properties: {
      info: {
        id: "msg_empty",
        sessionID: "ses_child",
        role: "assistant",
        parentID: "msg_first",
        time: { created: 2 },
        agent: "build",
        mode: "build",
        providerID: "provider",
        modelID: "model",
        path: { cwd: "/repo", root: "/repo" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
  })
  await ctx.store.interrupt("ses_child")
  expect(ctx.store.stopped("msg_first")).toBe(true)
})

test("700 terminal text is visible immediately when its start event was missed", () => {
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
    properties: { timestamp: 1, sessionID: "ses_child", messageID: "msg_700_user", prompt: { text: "你是什么模型" } },
  })
  ctx.store.apply({
    type: "session.next.step.started",
    properties: {
      timestamp: 2,
      sessionID: "ses_child",
      assistantMessageID: "msg_700_answer",
      agent: "build",
      model: { id: "model", providerID: "provider" },
    },
  })
  ctx.store.apply({
    type: "session.next.text.ended",
    properties: {
      timestamp: 5,
      sessionID: "ses_child",
      assistantMessageID: "msg_700_answer",
      textID: "text_0",
      text: "我是当前选择的模型。",
    },
  })
  expect(unwrap(ctx.store.data.part.msg_700_answer)).toMatchObject([
    { id: "msg_700_answer:text_0", type: "text", text: "我是当前选择的模型。" },
  ])
})

test("700 revert clear refresh does not join an older stale session snapshot", async () => {
  const gate = Promise.withResolvers<void>()
  const sessions: Record<string, SessionV2Info> = {
    ses_child: { ...info("ses_child"), revert: { messageID: "msg_undone" } },
  }
  const ctx = setup({ sessions, getWait: () => gate.promise })
  const first = ctx.store.resolve("ses_child")
  sessions.ses_child = info("ses_child")
  ctx.store.apply({ type: "session.next.revert.cleared", properties: { sessionID: "ses_child" } })
  gate.resolve()
  await first
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(ctx.requests.get).toHaveLength(2)
  expect(ctx.store.get("ses_child")?.revert).toBeUndefined()
})

test("701 silent current-view resync clears stale busy and stale permissions and reads the final answer", async () => {
  const ctx = setup({ pages: [{ data: [user("msg_user", "go", 1), assistant("msg_final", "final without SSE", 2)] }] })
  await ctx.store.resolve("ses_child")
  ctx.store.pin("ses_child")
  ctx.store.set("session_status", "ses_child", { type: "busy" })
  ctx.store.set("permission", "ses_child", [
    { id: "per_stale", sessionID: "ses_child", permission: "bash", patterns: [], always: [], metadata: {} },
  ])
  await ctx.store.resyncSilent()
  expect(ctx.store.data.session_working("ses_child")).toBe(false)
  expect(ctx.store.data.permission.ses_child).toEqual([])
  expect(unwrap(ctx.store.data.part.msg_final)).toMatchObject([{ text: "final without SSE" }])
  ctx.store.unpin("ses_child")
})
test("701 admitted queue is immediately visible and does not make an idle session busy", async () => {
  const ctx = setup({})
  await ctx.store.resolve("ses_child")
  ctx.store.apply({
    type: "session.next.prompt.admitted",
    properties: {
      sessionID: "ses_child",
      messageID: "msg_queue",
      timestamp: 5,
      delivery: "queue",
      prompt: { text: "after task" },
    },
  })
  expect(ctx.store.data.message.ses_child).toContainEqual(expect.objectContaining({ id: "msg_queue", role: "user" }))
  expect(unwrap(ctx.store.data.part.msg_queue)).toMatchObject([
    { text: "after task", metadata: { zaovraDelivery: "queue" } },
  ])
  expect(ctx.store.data.session_working("ses_child")).toBe(false)
})

test("701 reconnect refreshes pinned current history without switching windows", async () => {
  const loaded = Promise.withResolvers<void>()
  const ctx = setup({
    pages: [{ data: [user("msg_user", "go", 1), assistant("msg_reconnected", "answer after reconnect", 2)] }],
    pageWait: async () => {
      loaded.resolve()
    },
  })
  await ctx.store.resolve("ses_child")
  ctx.store.pin("ses_child")
  ctx.store.set("session_status", "ses_child", { type: "busy" })
  ctx.store.apply({ type: "server.connected", properties: {} })
  await loaded.promise
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(unwrap(ctx.store.data.part.msg_reconnected)).toMatchObject([{ text: "answer after reconnect" }])
  expect(ctx.store.data.session_working("ses_child")).toBe(false)
  ctx.store.unpin("ses_child")
})

test("701 legacy text deltas count as session activity before silent resync", async () => {
  const ctx = setup({})
  await ctx.store.resolve("ses_child")
  ctx.store.pin("ses_child")
  ctx.store.set("message", "ses_child", [
    {
      id: "msg_legacy",
      sessionID: "ses_child",
      role: "user",
      agent: "build",
      model: { providerID: "p", modelID: "m" },
      time: { created: 1 },
    },
  ])
  ctx.store.set("part", "msg_legacy", [
    { id: "prt_legacy", messageID: "msg_legacy", sessionID: "ses_child", type: "text", text: "begin" },
  ])
  const before = ctx.requests.get.length
  ctx.store.apply({
    type: "message.part.delta",
    properties: { messageID: "msg_legacy", partID: "prt_legacy", field: "text", delta: " more" },
  })
  await ctx.store.resyncSilent(Date.now() + 14000)
  expect(ctx.requests.get.length).toBe(before)
  ctx.store.unpin("ses_child")
})

for (const delivery of ["queue", "steer"] as const) {
  test(`707 pending ${delivery} HTTP, admission and optimistic messages never parent the active reply`, async () => {
    const pending: SessionInputAdmitted[] = [2, 3].map((n) => ({
      id: `msg_u${n}`,
      sessionID: "ses_child",
      delivery,
      prompt: { text: `next ${n}` },
      admittedSeq: n,
      timeCreated: n,
    }))
    const ctx = setup({ pending, pages: [{ data: [user("msg_u1", "first", 1)] }], wait: () => new Promise(() => {}) })
    await ctx.store.sync("ses_child")
    const step = (id: string) =>
      ctx.store.apply({
        type: "session.next.step.started",
        properties: {
          sessionID: "ses_child",
          assistantMessageID: id,
          timestamp: 10,
          agent: "build",
          model: { id: "model", providerID: "provider" },
        },
      })
    step("msg_a1")
    expect(unwrap(ctx.store.data.message.ses_child.find((item) => item.id === "msg_a1"))).toMatchObject({
      parentID: "msg_u1",
    })
    ctx.store.apply({
      type: "session.next.prompt.admitted",
      properties: { sessionID: "ses_child", messageID: "msg_u4", delivery, timestamp: 4, prompt: { text: "later" } },
    })
    ctx.store.optimistic.add({
      sessionID: "ses_child",
      message: {
        id: "msg_u5",
        role: "user",
        sessionID: "ses_child",
        agent: "build",
        model: { providerID: "p", modelID: "m" },
        time: { created: 5 },
      },
      parts: [
        {
          id: "msg_u5:text",
          messageID: "msg_u5",
          sessionID: "ses_child",
          type: "text",
          text: "optimistic",
          metadata: { zaovraDelivery: delivery },
        },
      ],
    })
    step("msg_a2")
    expect(unwrap(ctx.store.data.message.ses_child.find((item) => item.id === "msg_a2"))).toMatchObject({
      parentID: "msg_u1",
    })
    ctx.store.apply({
      type: "session.next.prompted",
      properties: { sessionID: "ses_child", messageID: "msg_u2", delivery, timestamp: 11, prompt: { text: "next 2" } },
    })
    step("msg_a3")
    expect(unwrap(ctx.store.data.message.ses_child.find((item) => item.id === "msg_a3"))).toMatchObject({
      parentID: "msg_u2",
    })
    const refreshed = setup({
      pending: pending.slice(1),
      pages: [
        {
          data: [
            user("msg_u1", "first", 1),
            assistant("msg_a1", "step1", 10),
            user("msg_u2", "next 2", 11),
            assistant("msg_a3", "step2", 12),
          ],
        },
      ],
    })
    await refreshed.store.sync("ses_child")
    expect(unwrap(refreshed.store.data.message.ses_child.find((item) => item.id === "msg_a3"))).toMatchObject({
      parentID: "msg_u2",
    })
  })
}

test("707 silent and reconnect question resync recovers lost asked and removes replies from another window", async () => {
  let pending: QuestionView[] = [{ id: "q_lost", sessionID: "ses_child", questions: [] }]
  const ctx = setup({ questions: async () => pending })
  await ctx.store.resolve("ses_child")
  ctx.store.pin("ses_child")
  await ctx.store.resyncSilent()
  expect(ctx.store.data.question.ses_child).toEqual(pending)
  pending = []
  await ctx.store.resync("ses_child")
  expect(ctx.store.data.question.ses_child).toEqual([])
  pending = [{ id: "q_reconnect", sessionID: "ses_child", questions: [] }]
  ctx.store.apply({ type: "server.connected", properties: {} })
  await ctx.store.resync("ses_child")
  expect(ctx.store.data.question.ses_child).toEqual(pending)
  ctx.store.unpin("ses_child")
})

for (const event of ["question.asked", "question.replied", "question.rejected"]) {
  test(`707 directory and current-view shared question load preserves in-flight ${event}`, async () => {
    const gate = Promise.withResolvers<QuestionView[]>()
    const entered = Promise.withResolvers<void>()
    let calls = 0
    const ctx = setup({
      questions: () => {
        calls++
        entered.resolve()
        return gate.promise
      },
    })
    await ctx.store.resolve("ses_child")
    ctx.store.set("question", "ses_child", [{ id: "q_old", sessionID: "ses_child", questions: [] }])
    const bootstrap = ctx.store.questions.sync("/repo")
    await entered.promise
    const current = ctx.store.resync("ses_child")
    ctx.store.apply({
      type: event,
      properties:
        event === "question.asked"
          ? { id: "q_new", sessionID: "ses_child", questions: [] }
          : { requestID: "q_old", sessionID: "ses_child" },
    })
    gate.resolve([{ id: "q_old", sessionID: "ses_child", questions: [] }])
    await Promise.all([bootstrap, current])
    expect(calls).toBe(1)
    expect(ctx.store.data.question.ses_child.map((item) => item.id)).toEqual(
      event === "question.asked" ? ["q_new", "q_old"] : [],
    )
  })
}

test("707 pending HTTP admission remains excluded when unrelated SSE arrives during its snapshot", async () => {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const ctx = setup({
    pending: [
      {
        id: "msg_u2",
        sessionID: "ses_child",
        admittedSeq: 2,
        timeCreated: 2,
        delivery: "queue",
        prompt: { text: "later" },
      },
    ],
    pages: [{ data: [user("msg_u1", "current", 1)] }],
    pendingWait: () => {
      entered.resolve()
      return gate.promise
    },
    wait: () => new Promise(() => {}),
  })
  const loading = ctx.store.sync("ses_child")
  await entered.promise
  ctx.store.apply({ type: "question.asked", properties: { id: "q_progress", sessionID: "ses_child", questions: [] } })
  gate.resolve()
  await loading
  ctx.store.apply({
    type: "session.next.step.started",
    properties: {
      sessionID: "ses_child",
      assistantMessageID: "msg_a",
      timestamp: 3,
      agent: "build",
      model: { id: "m", providerID: "p" },
    },
  })
  expect(unwrap(ctx.store.data.message.ses_child.find((item) => item.id === "msg_a"))).toMatchObject({
    parentID: "msg_u1",
  })
})

test("742 background completion recovers after its final ownership check disconnects", async () => {
  const disconnected = Promise.withResolvers<void>()
  let waits = 0
  let ownership = 0
  const ctx = setup({
    wait: () => (++waits === 1 ? disconnected.promise : Promise.resolve()),
    active: () => {
      if (++ownership === 1) throw new Error("ownership disconnected")
      return {}
    },
    pages: [{ data: [user("msg_user", "go", 1), assistant("msg_done", "background final", 2)] }],
  })
  await ctx.store.resolve("ses_child")
  ctx.store.set("session_status", "ses_child", { type: "busy" })
  const watching = ctx.store.watchExecution("ses_child")
  ctx.store.apply({
    type: "session.next.step.ended",
    properties: { sessionID: "ses_child", assistantMessageID: "msg_done", timestamp: 3, finish: "stop" },
  })
  disconnected.reject(new Error("wait disconnected"))
  await expect(watching).rejects.toThrow("ownership disconnected")
  expect(ctx.store.data.session_working("ses_child")).toBe(true)
  await ctx.store.resyncSilent(Date.now() + 1000)
  expect(ctx.store.data.session_working("ses_child")).toBe(false)
  expect(unwrap(ctx.store.data.part.msg_done)).toMatchObject([{ text: "background final" }])
})

test("742 recovery leaves an owned continuing task busy and does not duplicate its wait", async () => {
  const owner = Promise.withResolvers<void>()
  let waits = 0
  const ctx = setup({
    wait: () => {
      waits++
      return owner.promise
    },
  })
  await ctx.store.resolve("ses_child")
  ctx.store.set("session_status", "ses_child", { type: "busy" })
  const watching = ctx.store.watchExecution("ses_child")
  await ctx.store.resyncSilent(Date.now() + 1000)
  expect(waits).toBe(1)
  expect(ctx.store.data.session_working("ses_child")).toBe(true)
  owner.resolve()
  await watching
  expect(ctx.store.data.session_working("ses_child")).toBe(false)
})

describe("live text stream marker", () => {
  // Keeps the execution watcher parked so ownership only changes through the path under test.
  const hold = () => new Promise<void>(() => {})
  const delta = (delta: string, textID = "text-0") => ({
    type: "session.next.text.delta",
    properties: { sessionID: "ses_child", assistantMessageID: "msg_answer", textID, delta },
  })
  const started = {
    type: "session.next.step.started",
    properties: {
      sessionID: "ses_child",
      timestamp: 1,
      assistantMessageID: "msg_answer",
      agent: "build",
      model: { id: "model", providerID: "provider" },
    },
  }
  const textStarted = {
    type: "session.next.text.started",
    properties: { sessionID: "ses_child", timestamp: 2, assistantMessageID: "msg_answer", textID: "text-0" },
  }
  const answer = (completed: boolean): SessionMessage => ({
    ...assistant("msg_answer", "Written", 2),
    content: [{ id: "text-0", type: "text", text: "Written" }],
    time: completed ? { created: 2, completed: 3 } : { created: 2 },
  })
  const page = (completed: boolean) => ({ data: [user("msg_user", "Go", 1), answer(completed)] })
  const live = async (ctx: ReturnType<typeof setup>) => {
    await ctx.store.sync("ses_child")
    ctx.store.apply(started)
    ctx.store.apply(textStarted)
    expect(ctx.store.data.streaming_text.ses_child).toBeUndefined()
    ctx.store.apply(delta("Writ"))
    expect(ctx.store.data.streaming_text.ses_child).toBeDefined()
  }

  test("a completed snapshot clears the marker while ownership stays busy", async () => {
    const ctx = setup({
      wait: hold,
      pages: [{ data: [] }, page(true)],
      active: () => ({ ses_child: { type: "running" } }),
    })
    await live(ctx)
    await ctx.store.resync("ses_child")
    expect(ctx.store.data.session_status.ses_child).toEqual({ type: "busy" })
    expect(ctx.store.data.streaming_text.ses_child).toBeUndefined()
  })

  test("confirmed idle clears the marker so the same turn does not resume writing", async () => {
    const ctx = setup({ wait: hold, pages: [{ data: [] }] })
    await live(ctx)
    ctx.store.apply({ type: "session.status", properties: { sessionID: "ses_child", status: { type: "idle" } } })
    expect(ctx.store.data.streaming_text.ses_child).toBeUndefined()
    ctx.store.apply({ type: "session.status", properties: { sessionID: "ses_child", status: { type: "busy" } } })
    expect(ctx.store.data.streaming_text.ses_child).toBeUndefined()
  })

  test("ownership that confirms idle during resync clears the marker", async () => {
    const ctx = setup({ wait: hold, pages: [{ data: [] }, page(false)], active: () => ({}) })
    await live(ctx)
    await ctx.store.resync("ses_child")
    expect(ctx.store.data.session_status.ses_child).toEqual({ type: "idle" })
    expect(ctx.store.data.streaming_text.ses_child).toBeUndefined()
  })

  test("a normal reconnect clears the marker and the next delta restores it", async () => {
    const ctx = setup({ wait: hold, pages: [{ data: [] }] })
    await live(ctx)
    ctx.store.apply({ type: "server.connected", properties: {} })
    expect(ctx.store.data.streaming_text.ses_child).toBeUndefined()
    ctx.store.apply(delta("ten"))
    expect(ctx.store.data.streaming_text.ses_child).toBeDefined()
  })

  test("a snapshot requested before a new delta cannot clear that delta's stream", async () => {
    const gate = Promise.withResolvers<void>()
    const requested = Promise.withResolvers<void>()
    let held = false
    const ctx = setup({
      wait: hold,
      pages: [{ data: [] }, page(true)],
      active: () => ({ ses_child: { type: "running" } }),
      pageWait: async () => {
        if (!held) return
        requested.resolve()
        await gate.promise
      },
    })
    await live(ctx)
    held = true
    const resync = ctx.store.resync("ses_child")
    await requested.promise
    ctx.store.apply(delta("ten"))
    gate.resolve()
    await resync
    expect(ctx.store.data.streaming_text.ses_child).toBeDefined()
  })

  test("an unfinished live snapshot keeps the marker", async () => {
    const ctx = setup({
      wait: hold,
      pages: [{ data: [] }, page(false)],
      active: () => ({ ses_child: { type: "running" } }),
    })
    await live(ctx)
    await ctx.store.resync("ses_child")
    expect(ctx.store.data.session_status.ses_child).toEqual({ type: "busy" })
    expect(ctx.store.data.streaming_text.ses_child).toBeDefined()
  })

  test("a completed snapshot of another assistant leaves the marker alone", async () => {
    const other = { ...assistant("msg_other", "Earlier", 0), time: { created: 0, completed: 1 } }
    const ctx = setup({
      wait: hold,
      pages: [{ data: [] }, { data: [other, user("msg_user", "Go", 1), answer(false)] }],
      active: () => ({ ses_child: { type: "running" } }),
    })
    await live(ctx)
    await ctx.store.resync("ses_child")
    expect(ctx.store.data.streaming_text.ses_child).toBeDefined()
  })

  test("text end, step end and retry still clear the marker", async () => {
    const ctx = setup({ wait: hold, pages: [{ data: [] }] })
    await live(ctx)
    ctx.store.apply({
      type: "session.next.text.ended",
      properties: {
        sessionID: "ses_child",
        timestamp: 3,
        assistantMessageID: "msg_answer",
        textID: "text-0",
        text: "Writ",
      },
    })
    expect(ctx.store.data.streaming_text.ses_child).toBeUndefined()
    ctx.store.apply(delta("More", "text-1"))
    expect(ctx.store.data.streaming_text.ses_child).toBeDefined()
    ctx.store.apply({
      type: "session.next.step.ended",
      properties: { sessionID: "ses_child", timestamp: 4, assistantMessageID: "msg_answer", finish: "stop" },
    })
    expect(ctx.store.data.streaming_text.ses_child).toBeUndefined()
    ctx.store.apply(delta("Again", "text-2"))
    ctx.store.apply({
      type: "session.next.retried",
      properties: { sessionID: "ses_child", timestamp: 5, attempt: 2, error: { message: "Retry" } },
    })
    expect(ctx.store.data.streaming_text.ses_child).toBeUndefined()
  })
})

test("a server without the ordered feed is re-read on a clock, not once per tool event", async () => {
  const ctx = setup({ pages: [{ data: [user("msg_user", "go", 1)] }] })
  await ctx.store.sync("ses_child")
  const before = ctx.requests.messages.length
  // Tool calls arrive further apart than any debounce, as they do in a real turn.
  for (const index of Array.from({ length: 12 }, (_, index) => index)) {
    for (const type of ["session.next.tool.called", "session.next.tool.success"])
      ctx.store.apply({ type, properties: { sessionID: "ses_child", callID: `call_${index}`, timestamp: index } })
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  expect(ctx.requests.messages.length).toBe(before)
  await new Promise((resolve) => setTimeout(resolve, 2100))
  expect(ctx.requests.messages.length).toBe(before + 1)
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(ctx.requests.messages.length).toBe(before + 1)
}, 10000)

test("Stop marks the user's prompt, not a command record that came after it", async () => {
  const ctx = setup({
    pages: [
      {
        data: [
          user("msg_first", "Task", 1),
          // A command record: stored as a user-side message whose ID sorts after every reply.
          { id: "msg_zz_shell", type: "shell", command: "ls", output: "", time: { created: 2, completed: 3 } } as never,
        ],
      },
    ],
  })
  await ctx.store.sync("ses_child")
  ctx.store.set("session_status", "ses_child", { type: "busy" })
  await ctx.store.interrupt("ses_child")
  expect(ctx.store.stopped("msg_zz_shell")).toBe(false)
  expect(ctx.store.stopped("msg_first")).toBe(true)
})
