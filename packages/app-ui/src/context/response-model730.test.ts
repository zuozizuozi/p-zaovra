import { expect, test } from "bun:test"
import { createServerSession } from "./server-session"
import { adaptSession, adaptSessionMessages } from "./v2-session-adapter"
import type { ZaovraClient, SessionV2Info, SessionMessage } from "@zaovra-ai/sdk/v2/client"

const session: SessionV2Info = {
  id: "ses_model730",
  projectID: "project",
  agent: "build",
  model: { id: "selected-alias", providerID: "provider" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  title: "730",
  location: { directory: "F:/synthetic730" },
}
function setup() {
  const history = Promise.withResolvers<void>()
  const historyStarted = Promise.withResolvers<void>()
  const messages: SessionMessage[] = [
    { id: "a-user", type: "user", text: "Test", time: { created: 1 } },
    ...["b-answer", "c-other"].map((id) => ({
      id,
      type: "assistant" as const,
      agent: "build",
      model: session.model!,
      time: { created: 2 },
      content: [
        { id: "text-0", type: "text" as const, text: "Result" },
        { id: "text-1", type: "text" as const, text: "Result tail" },
      ],
    })),
  ]
  const client = {
    v2: {
      session: {
        active: async () => ({ data: { data: {} } }),
        wait: async () => {},
        get: async () => ({ data: { data: session } }),
        messages: async () => {
          historyStarted.resolve()
          await history.promise
          return { data: { data: messages, cursor: {} } }
        },
        pendingInputs: async () => ({ data: { data: [] } }),
      },
      question: { request: { list: async () => ({ data: { data: [] } }) } },
      permission: { request: { list: async () => ({ data: { data: [] } }) } },
    },
  } as unknown as ZaovraClient
  const store = createServerSession(client)
  store.set("info", session.id, adaptSession(session))
  const rows = adaptSessionMessages(session, messages)
  store.set(
    "message",
    session.id,
    rows.map((row) => row.message),
  )
  for (const row of rows) store.set("part", row.message.id, row.parts)
  return { store, history, historyStarted }
}

test("730 live Step.Ended projects actual model to every owned text part before HTTP recovery", () => {
  const ctx = setup()
  try {
    ctx.store.apply({
      type: "session.next.step.ended",
      properties: {
        sessionID: session.id,
        assistantMessageID: "b-answer",
        timestamp: 3,
        finish: "stop",
        responseModel: "actual-wire730",
      },
    })
    expect(
      ctx.store.data.part["b-answer"].map((part) =>
        "metadata" in part ? part.metadata?.zaovraResponseModel : undefined,
      ),
    ).toEqual(["actual-wire730", "actual-wire730"])
    expect(
      ctx.store.data.part["c-other"].some((part) => "metadata" in part && part.metadata?.zaovraResponseModel),
    ).toBe(false)
    expect(ctx.store.data.message[session.id].find((message) => message.id === "b-answer")).toMatchObject({
      modelID: "selected-alias",
      providerID: "provider",
    })
  } finally {
    ctx.history.resolve()
  }
})

test("730 an older in-flight HTTP snapshot cannot erase a newly reported live model", async () => {
  const ctx = setup()
  const load = ctx.store.sync(session.id, { force: true })
  try {
    await ctx.historyStarted.promise
    ctx.store.apply({
      type: "session.next.step.ended",
      properties: {
        sessionID: session.id,
        assistantMessageID: "b-answer",
        timestamp: 3,
        finish: "stop",
        responseModel: "new-live-wire730",
      },
    })
    ctx.history.resolve()
    await load
    expect(
      ctx.store.data.part["b-answer"].map((part) =>
        "metadata" in part ? part.metadata?.zaovraResponseModel : undefined,
      ),
    ).toEqual(["new-live-wire730", "new-live-wire730"])
    expect(ctx.store.data.message[session.id].find((message) => message.id === "b-answer")).toMatchObject({
      time: { completed: 3 },
      modelID: "selected-alias",
    })
  } finally {
    ctx.history.resolve()
    await load
  }
})

test("730 absent or blank live model never invents actual identity", () => {
  const ctx = setup()
  try {
    for (const responseModel of [undefined, "", "   "])
      ctx.store.apply({
        type: "session.next.step.ended",
        properties: {
          sessionID: session.id,
          assistantMessageID: "b-answer",
          timestamp: 3,
          finish: "stop",
          responseModel,
        },
      })
    expect(
      ctx.store.data.part["b-answer"].some((part) => "metadata" in part && part.metadata?.zaovraResponseModel),
    ).toBe(false)
    expect(ctx.store.data.message[session.id].find((message) => message.id === "b-answer")).toMatchObject({
      modelID: "selected-alias",
    })
  } finally {
    ctx.history.resolve()
  }
})
