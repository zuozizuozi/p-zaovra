import { describe, expect, test } from "bun:test"
import type { SessionInputAdmitted, SessionMessage, SessionV2Info } from "@zaovra-ai/sdk/v2/client"
import { adaptSessionInput, adaptSessionMessages } from "./v2-session-adapter"

const session: SessionV2Info = {
  id: "ses_test",
  projectID: "project",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  title: "test",
  location: { directory: "/repo" },
}

describe("V2 session timeline adapter", () => {
  test("maps a durable pending input into a visible user message", () => {
    const input: SessionInputAdmitted = {
      admittedSeq: 3,
      id: "msg_pending",
      sessionID: session.id,
      prompt: { text: "also update the tests" },
      delivery: "steer",
      timeCreated: 4,
    }

    expect(adaptSessionInput(session, input)).toMatchObject({
      message: { id: "msg_pending", role: "user", time: { created: 4 } },
      parts: [{ id: "msg_pending:text", type: "text", text: "also update the tests" }],
    })
  })

  test("keeps user attachments and assigns assistants to the consumed user turn", () => {
    const messages: SessionMessage[] = [
      {
        id: "msg_user",
        type: "user",
        text: "inspect this",
        files: [{ uri: "file:///repo/a.ts", mime: "text/typescript", name: "a.ts" }],
        agents: [{ name: "reviewer", source: { text: "@reviewer", start: 0, end: 9 } }],
        time: { created: 1 },
      },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ id: "text_1", type: "text", text: "done" }],
        time: { created: 2, completed: 3 },
      },
    ]

    const result = adaptSessionMessages(session, messages)

    expect(result.map((item) => item.message.id)).toEqual(["msg_user", "msg_assistant"])
    expect(result[1].message).toMatchObject({ role: "assistant", parentID: "msg_user" })
    expect(result[0].parts.map((part) => part.type)).toEqual(["text", "file", "agent"])
    expect(result[1].parts).toEqual([
      { id: "text_1", sessionID: "ses_test", messageID: "msg_assistant", type: "text", text: "done" },
    ])
  })

  test("does not attach an assistant to a newer unrelated user when a page lacks its parent", () => {
    const messages: SessionMessage[] = [
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ id: "text_1", type: "text", text: "older answer" }],
        time: { created: 1 },
      },
      { id: "msg_new_user", type: "user", text: "new request", time: { created: 2 } },
    ]

    expect(adaptSessionMessages(session, messages).map((item) => item.message.id)).toEqual(["msg_new_user"])
  })

  test("maps tool completion into the existing desktop tool part contract", () => {
    const messages: SessionMessage[] = [
      { id: "msg_user", type: "user", text: "run", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            id: "call_1",
            type: "tool",
            name: "shell",
            time: { created: 2, ran: 2, completed: 3 },
            state: {
              status: "completed",
              input: { command: "pwd" },
              structured: {},
              content: [{ type: "text", text: "/repo" }],
            },
          },
        ],
        time: { created: 2, completed: 3 },
      },
    ]

    expect(adaptSessionMessages(session, messages)[1].parts[0]).toMatchObject({
      type: "tool",
      tool: "shell",
      state: { status: "completed", output: "/repo" },
    })
  })
})
