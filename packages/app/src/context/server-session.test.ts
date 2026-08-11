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
}) {
  const sessions = input.sessions ?? { ses_child: info("ses_child") }
  const pages = input.pages ?? [{ data: [] }]
  const requests = {
    get: [] as string[],
    messages: [] as { sessionID: string; cursor?: string }[],
    pending: [] as string[],
  }
  const client = {
    v2: {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          requests.get.push(sessionID)
          return { data: { data: sessions[sessionID] } }
        },
        messages: async ({ sessionID, cursor }: { sessionID: string; cursor?: string }) => {
          requests.messages.push({ sessionID, cursor })
          const page = pages.shift() ?? { data: [] }
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

const assistant = (id: string, text: string, created: number): SessionMessage => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [{ id: `${id}:text`, type: "text", text }],
  time: { created, completed: created + 1 },
})

describe("V2 server session store", () => {
  test("resolves parent lineage only through V2 Session", async () => {
    const ctx = setup({ sessions: { ses_child: info("ses_child", "ses_root"), ses_root: info("ses_root") } })

    const result = await ctx.store.lineage.resolve("ses_child")

    expect(result.root.id).toBe("ses_root")
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
    expect(ctx.store.data.part.msg_002).toMatchObject([{ id: "text_1", text: "hello" }])
  })
})
