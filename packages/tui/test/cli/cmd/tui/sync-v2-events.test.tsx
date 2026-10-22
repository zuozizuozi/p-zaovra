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

test("host completion live projection preserves typed source identity and matches durable reload", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const completion = { type: "bash-completion" as const, sourceMessageID: userID, jobID: "job_task" }
  const original = { id: userID, type: "user" as const, text: "Original task", time: { created: 1 } }
  const host = {
    id: "msg_host",
    type: "synthetic" as const,
    sessionID,
    text: "Task completed",
    completion,
    time: { created: 2 },
  }
  let promoted = false
  const { app, emit, sync, data } = await mount((url) => {
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: info })
    if (url.pathname === `/api/session/${sessionID}/message`)
      return json({ data: promoted ? [host, original] : [original] })
    if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
    return undefined
  }, tmp.path)
  try {
    await sync.session.sync(sessionID)
    promoted = true
    const event = global({
      id: "host-completion",
      type: "session.next.prompted",
      properties: {
        timestamp: 2,
        sessionID,
        messageID: host.id,
        prompt: { text: host.text },
        delivery: "queue",
        completion,
      },
    })
    emit(event)
    emit({ ...event, payload: { ...event.payload, id: "host-completion-duplicate" } })
    await wait(() => data.session.message.list(sessionID)?.some((item) => item.id === host.id) === true)
    expect(data.session.message.list(sessionID)?.filter((item) => item.id === host.id)).toEqual([host])
    await data.session.message.refresh(sessionID)
    expect(data.session.message.list(sessionID)).toEqual([host, original])
    await wait(() => sync.data.part[host.id]?.some((part) => part.type === "text" && part.synthetic === true) === true)
    expect(sync.data.part[userID]?.some((part) => part.type === "text" && part.text === "Original task")).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("S1 terminal waits deduplicate and clear busy after host release later than 100ms", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let waits = 0
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: info })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/wait`) {
      waits++
      return gate.then(() => json({ data: {} }))
    }
    if (url.pathname === "/api/session/active") return json({ data: {} })
    return undefined
  }, tmp.path)
  try {
    await sync.session.sync(sessionID)
    emit(
      global({
        id: "evt-start",
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
    const terminal = {
      id: "evt-end",
      type: "session.next.step.ended" as const,
      properties: {
        timestamp: 3,
        sessionID,
        assistantMessageID: assistantID,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }
    emit(global(terminal))
    emit(global({ ...terminal, id: "evt-end2" }))
    await wait(() => waits > 0)
    await Bun.sleep(150)
    expect(sync.data.session_status[sessionID]?.type).toBe("busy")
    expect(waits).toBe(1)
    release()
    await wait(() => sync.data.session_status[sessionID]?.type === "idle")
    expect(waits).toBe(1)
  } finally {
    release()
    app.renderer.destroy()
  }
})

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

test("S1 disposal cancels pending host convergence without updating stale state", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const gate = Promise.withResolvers<void>()
  let waits = 0
  let active = 0
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/api/session/${sessionID}`) return json({ data: info })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/todo`) return json({ data: [] })
    if (url.pathname === `/api/session/${sessionID}/wait`) {
      waits++
      return gate.promise.then(() => json({ data: {} }))
    }
    if (url.pathname === "/api/session/active") {
      active++
      return json({ data: {} })
    }
    return undefined
  }, tmp.path)
  await sync.session.sync(sessionID)
  emit(
    global({
      id: "start-dispose",
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
      id: "end-dispose",
      type: "session.next.step.ended",
      properties: {
        timestamp: 3,
        sessionID,
        assistantMessageID: assistantID,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }),
  )
  await wait(() => waits === 1)
  app.renderer.destroy()
  const before = active
  gate.resolve()
  await Bun.sleep(30)
  expect(active).toBe(before)
  expect(sync.data.session_status[sessionID]?.type).toBe("busy")
})
