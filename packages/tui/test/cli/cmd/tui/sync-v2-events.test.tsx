/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@zaovra-ai/sdk/v2"
import { json, mount, wait } from "./sync-fixture"
import { tmpdir } from "../../../fixture/fixture"

const sessionID = "ses_v2_stream"
const userID = "msg_user"
const assistantID = "msg_assistant"
const textID = "text_visible"
const info = {
  id: sessionID,
  projectID: "proj_test",
  agent: "build",
  model: { providerID: "test", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  title: "V2 stream",
  location: { directory: "/tmp/zaovra/packages/tui" },
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: info.location.directory, project: info.projectID, payload }
}

test("session.next text events reach the visible sync message and part store", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: info })
    if (url.pathname === `/api/session/${sessionID}/message`)
      return json({
        data: [{ id: userID, type: "user", text: "hello", time: { created: 1 } }],
      })
    if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
    return undefined
  }, tmp.path)

  try {
    await sync.session.sync(sessionID)
    emit(
      global({
        id: "evt_step",
        type: "session.next.step.started",
        properties: {
          timestamp: 2,
          sessionID,
          assistantMessageID: assistantID,
          agent: "build",
          model: { providerID: "test", id: "model" },
        },
      }),
    )
    emit(
      global({
        id: "evt_start",
        type: "session.next.text.started",
        properties: { timestamp: 3, sessionID, assistantMessageID: assistantID, textID },
      }),
    )
    emit(
      global({
        id: "evt_delta",
        type: "session.next.text.delta",
        properties: { timestamp: 4, sessionID, assistantMessageID: assistantID, textID, delta: "visible" },
      }),
    )
    emit(
      global({
        id: "evt_end",
        type: "session.next.text.ended",
        properties: { timestamp: 5, sessionID, assistantMessageID: assistantID, textID, text: "visible output" },
      }),
    )

    await wait(
      () =>
        sync.data.part[assistantID]?.some((part) => part.type === "text" && part.text === "visible output") === true,
    )
    expect(sync.data.message[sessionID]?.some((message) => message.id === assistantID)).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})
