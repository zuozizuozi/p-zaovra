import { expect, test } from "bun:test"
import type { Event } from "@zaovra-ai/sdk/v2/client"
import { adaptServerEvent } from "./server-event"
import { createServerSession } from "./server-session"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"

test("normalizes V2 permission fields before subscribers receive the event", () => {
  expect(adaptServerEvent({
    id: "evt_permission", type: "permission.v2.asked",
    properties: {
      id: "per_test", sessionID: "ses_test", action: "bash", resources: ["echo test"],
      save: ["echo *"], metadata: { command: "echo test" },
      source: { type: "tool", messageID: "msg_test", callID: "call_test" },
    },
  })).toEqual({
    id: "evt_permission", type: "permission.asked",
    properties: {
      id: "per_test", sessionID: "ses_test", permission: "bash", patterns: ["echo test"],
      always: ["echo *"], metadata: { command: "echo test" },
      tool: { messageID: "msg_test", callID: "call_test" },
    },
  })
})

test("V2 approval and question replay is idempotent and replies clear pending UI", () => {
  const state = createServerSession(createZaovraClient({ baseUrl: "http://127.0.0.1:1" }))
  state.remember({ id: "ses_test", slug: "test", projectID: "project", directory: "/repo", title: "test", version: "", time: { created: 1, updated: 1 } })
  const permission: Event = { id: "evt_1", type: "permission.v2.asked", properties: { id: "per_test", sessionID: "ses_test", action: "bash", resources: ["echo test"] } }
  state.apply(permission)
  state.apply(permission)
  expect(state.data.permission.ses_test.length).toBe(1)
  expect(state.data.permission.ses_test[0].permission).toBe("bash")
  state.apply({ type: "permission.v2.replied", properties: { sessionID: "ses_test", requestID: "per_test", reply: "once" } })
  expect(state.data.permission.ses_test.length).toBe(0)
  for (const type of ["question.v2.replied", "question.v2.rejected"]) {
    state.apply({ type: "question.v2.asked", properties: { id: "que_test", sessionID: "ses_test", questions: [] } })
    expect(state.data.question.ses_test[0].id).toBe("que_test")
    state.apply({ type, properties: { sessionID: "ses_test", requestID: "que_test", answers: [] } })
    expect(state.data.question.ses_test.length).toBe(0)
  }
})
