import { afterEach, expect, test } from "bun:test"
import { createRoot, createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import {
  createZaovraClient,
  type SessionInputAdmitted,
  type SessionMessage,
  type SessionV2Info,
} from "@zaovra-ai/sdk/v2/client"
import type { Message, Part, SessionStatus } from "@zaovra-ai/sdk/v2"
import { DataProvider } from "@zaovra-ai/session-ui/context"
import { UserMessageDisplay } from "@zaovra-ai/session-ui/message-part"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { DialogProvider } from "@zaovra-ai/ui/context/dialog"
import { FileComponentProvider } from "@zaovra-ai/ui/context/file"
import { adaptSessionMessages, adaptSessionInput } from "../../src/context/v2-session-adapter"
import { createServerSession } from "../../src/context/server-session"
import { createTimelineProjection } from "../../src/pages/session/timeline/projection"
import { pendingTurnLabel } from "@zaovra-ai/session-ui/turn-ownership"
const english = await import("../../src/i18n/en")
const chinese = await import("../../src/i18n/zh")

const session: SessionV2Info = {
  id: "ownership790",
  projectID: "fixed",
  agent: "build",
  model: { id: "fixed", providerID: "offline" },
  title: "Controlled ownership",
  location: { directory: "/fixture790" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}
const user = (id: string, created: number): SessionMessage => ({ id, type: "user", text: id, time: { created } })
const answer = (id: string, created: number, completed?: number): SessionMessage => ({
  id,
  type: "assistant",
  agent: "build",
  model: session.model!,
  content: [{ type: "text", id: "text", text: "A real adapted answer" }],
  time: { created, ...(completed === undefined ? {} : { completed }) },
  ...(completed === undefined ? {} : { finish: "stop" }),
})
const adapt = (raw: SessionMessage[]) => adaptSessionMessages(session, raw)
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.removeAttribute("data-new-layout")
})

function project(raw: SessionMessage[]) {
  const adapted = adapt(raw)
  const [state, setState] = createStore<{ messages: Message[]; parts: Record<string, Part[]>; status: SessionStatus }>({
    messages: adapted.map((item) => item.message).toSorted((a, b) => a.id.localeCompare(b.id)),
    parts: Object.fromEntries(adapted.map((item) => [item.message.id, item.parts])),
    status: { type: "busy" },
  })
  const projection = createRoot((dispose) => {
    cleanups.push(dispose)
    return createTimelineProjection({
      messages: () => state.messages,
      userMessages: () =>
        state.messages.filter((item) => item.role === "user").toSorted((a, b) => a.time.created - b.time.created),
      parts: (id) => state.parts[id] ?? [],
      status: () => state.status,
      showReasoningSummaries: () => true,
      inlineComments: () => false,
      historyComplete: () => true,
    })
  })
  return { state, setState, projection }
}

test("790 old unfinished history cannot steal a newly promoted current turn", () => {
  const ctx = project([user("old", 1), answer("old-finished", 3, 4), user("current", 5)])
  expect(ctx.projection.activeMessageID()).toBe("current")
  const stale = adapt([user("old", 1), answer("old-unfinished", 2)])[1].message
  ctx.setState(
    "messages",
    [...ctx.state.messages, stale].sort((a, b) => a.id.localeCompare(b.id)),
  )
  expect(ctx.projection.activeMessageID()).toBe("current")
  expect(ctx.projection.rows().some((row) => row._tag === "AssistantHeading" && row.userMessageID === "current")).toBe(
    true,
  )
})

test("790 pending steer and queue never replace a running owner; promotion does", () => {
  const ctx = project([user("running", 1), answer("in-flight", 2), user("steer", 3), user("queue", 4)])
  ctx.setState("parts", "steer", 0, "metadata", { zaovraDelivery: "steer" })
  ctx.setState("parts", "queue", 0, "metadata", { zaovraDelivery: "queue" })
  expect(ctx.projection.activeMessageID()).toBe("running")
  ctx.setState("parts", "steer", 0, "metadata", undefined)
  expect(ctx.projection.activeMessageID()).toBe("steer")
  expect(ctx.projection.activeMessageID()).not.toBe("queue")
  ctx.setState("status", { type: "idle" })
  expect(ctx.projection.activeMessageID()).toBeUndefined()
})

test("790 a completed task with a waiting new input has no historical execution owner", () => {
  const ctx = project([user("old", 1), answer("stale", 2), user("recent", 3), answer("done", 4, 5), user("next", 6)])
  ctx.setState("parts", "next", 0, "metadata", { zaovraDelivery: "steer" })
  expect(ctx.projection.activeMessageID()).toBeUndefined()
})

test.each(["steer", "queue"] as const)(
  "790 real SDK/store wait preserves %s until a wake, without polling spin",
  async (delivery) => {
    const pending: SessionInputAdmitted[] = [
      { id: "next", admittedSeq: 1, sessionID: session.id, timeCreated: 6, delivery, prompt: { text: "Next task" } },
    ]
    const requests: string[] = []
    const store = createServerSession(
      createZaovraClient({
        baseUrl: "http://fixed790.invalid",
        throwOnError: true,
        fetch: async (request) => {
          const path = new URL(
            typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
          ).pathname
          requests.push(path)
          if (path.endsWith("/wait")) return Response.json({ data: null })
          if (path.endsWith("/active")) return Response.json({ data: {} })
          if (path.endsWith("/input/pending")) return Response.json({ data: pending })
          if (path.endsWith("/message"))
            return Response.json({ data: [user("recent", 3), answer("done", 4, 5)], cursor: {} })
          if (path.endsWith("/" + session.id)) return Response.json({ data: session })
          throw new Error("Unexpected generated SDK request: " + path)
        },
      }),
    )
    await store.sync(session.id)
    store.set("session_status", session.id, { type: "busy" })
    const statuses: string[] = []
    createRoot((dispose) => {
      cleanups.push(dispose)
      createEffect(() => statuses.push(store.data.session_status[session.id].type))
    })
    await store.watchExecution(session.id)
    expect(store.data.session_working(session.id)).toBe(true)
    expect(statuses).not.toContain("idle")
    expect(requests.filter((path) => path.endsWith("/wait"))).toHaveLength(1)
    expect(store.data.pending_input[session.id][0].id).toBe("next")
    await store.resync(session.id)
    expect(store.data.session_working(session.id)).toBe(true)
    expect(store.pendingDelivery(session.id, "next")).toBe(delivery)
    pending.splice(0)
    await store.watchExecution(session.id)
    expect(store.data.session_working(session.id)).toBe(false)
  },
)

test("790 actual SDK/store promotion owns the provider turn while later file-only queue stays pending", async () => {
  const held = Promise.withResolvers<void>()
  const store = createServerSession(
    createZaovraClient({
      baseUrl: "http://fixed790.invalid",
      throwOnError: true,
      fetch: async (request) => {
        const path = new URL(
          typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
        ).pathname
        if (path.endsWith("/wait")) {
          await held.promise
          return Response.json({ data: null })
        }
        if (path.endsWith("/active")) return Response.json({ data: {} })
        if (path.endsWith("/" + session.id)) return Response.json({ data: session })
        throw new Error("Unexpected generated SDK request: " + path)
      },
    }),
  )
  try {
    await store.resolve(session.id)
    const initial = adapt([user("a-running", 1), answer("answer-a", 2)])
    store.set(
      "message",
      session.id,
      initial.map((item) => item.message).sort((a, b) => a.id.localeCompare(b.id)),
    )
    initial.forEach((item) => store.set("part", item.message.id, item.parts))
    store.set("session_status", session.id, { type: "busy" })
    const projection = createRoot((dispose) => {
      cleanups.push(dispose)
      return createTimelineProjection({
        messages: () => store.data.message[session.id] ?? [],
        userMessages: () => (store.data.message[session.id] ?? []).filter((item) => item.role === "user"),
        parts: (id) => store.data.part[id] ?? [],
        status: () => store.data.session_status[session.id] ?? { type: "idle" },
        showReasoningSummaries: () => true,
        inlineComments: () => false,
        pending: (id) => !!store.pendingDelivery(session.id, id),
      })
    })
    const input = {
      sessionID: session.id,
      messageID: "b-steer",
      timestamp: 3,
      delivery: "steer",
      prompt: { text: "Follow up" },
    }
    store.apply({ type: "session.next.prompt.admitted", properties: input })
    store.apply({
      type: "session.next.prompt.admitted",
      properties: {
        ...input,
        messageID: "c-queue",
        timestamp: 4,
        delivery: "queue",
        prompt: {
          text: "",
          files: [
            {
              name: "demo.pptx",
              mime: "application/octet-stream",
              uri: "data:application/octet-stream;base64,Zml4ZWQ=",
            },
          ],
        },
      },
    })
    expect(projection.activeMessageID()).toBe("a-running")
    expect(store.pendingDelivery(session.id, "b-steer")).toBe("steer")
    expect(store.pendingDelivery(session.id, "c-queue")).toBe("queue")
    store.apply({ type: "session.next.prompted", properties: input })
    expect(projection.activeMessageID()).toBe("b-steer")
    expect(store.pendingDelivery(session.id, "b-steer")).toBeUndefined()
    store.apply({
      type: "session.next.step.started",
      properties: {
        sessionID: session.id,
        assistantMessageID: "answer-b",
        timestamp: 5,
        agent: "build",
        model: session.model,
      },
    })
    expect(store.data.message[session.id].find((message) => message.id === "answer-b")).toMatchObject({
      parentID: "b-steer",
    })
    expect(projection.activeMessageID()).toBe("b-steer")
    expect(projection.activeMessageID()).not.toBe("c-queue")
    const watching = store.watchExecution(session.id)
    store.apply({ type: "session.next.deleted", properties: { sessionID: session.id } })
    held.resolve()
    await watching
  } finally {
    store.apply({ type: "session.next.deleted", properties: { sessionID: session.id } })
    held.resolve()
  }
})

test("790 pending copy distinguishes idle first work, running steer, and queue in both languages", () => {
  expect(pendingTurnLabel("steer", undefined, "new")).toBe("session.message.waitingToStart")
  expect(pendingTurnLabel("steer", "new", "new")).toBe("session.message.waitingToStart")
  expect(pendingTurnLabel("steer", "running", "new")).toBe("session.message.waitingToJoin")
  expect(pendingTurnLabel("queue", "running", "new")).toBe("session.message.queued")
  expect(pendingTurnLabel(undefined, "running", "new")).toBeUndefined()
  expect(chinese.dict["session.message.waitingToStart"]).toBe("待开始")
  expect(english.dict["session.message.waitingToStart"]).toBe("Waiting to start")
})

test.each([false, true])("790 %s layout opens the exact non-image attachment by click and keyboard", (v2) => {
  if (v2) document.body.setAttribute("data-new-layout", "true")
  const message = adapt([user("files", 1)])[0].message
  if (message.role !== "user") throw new Error("Expected actual user adapter")
  const file: Extract<Part, { type: "file" }> = {
    id: "ppt",
    messageID: message.id,
    sessionID: session.id,
    type: "file",
    filename: "demo.pptx",
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    url: "data:application/octet-stream;base64,Zml4ZWQ=",
  }
  const opened: Part[] = []
  const element = document.createElement("main")
  document.body.append(element)
  const dispose = render(
    () => (
      <I18nProvider value={{ locale: () => "en", t: (key) => key }}>
        <DialogProvider>
          <FileComponentProvider component={() => null}>
            <DataProvider
              directory="/fixture790"
              data={{ session: [], session_status: {}, session_diff: {}, message: {}, part: {} }}
            >
              <UserMessageDisplay
                message={message}
                parts={[file]}
                useV2Actions={v2}
                actions={{ openAttachment: (part) => opened.push(part) }}
              />
            </DataProvider>
          </FileComponentProvider>
        </DialogProvider>
      </I18nProvider>
    ),
    element,
  )
  cleanups.push(() => {
    dispose()
    element.remove()
  })
  const control = element.querySelector<HTMLElement>(
    v2 ? '[data-component="attachment-card-v2"]' : '[data-slot="user-message-attachment"]',
  )!
  expect(control).not.toBeNull()
  control.click()
  expect(opened.map((part) => part.id)).toEqual(["ppt"])
  expect(control.getAttribute("role")).toBe("button")
  expect(control.tabIndex).toBe(0)
  control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  expect(opened.map((part) => part.id)).toEqual(["ppt", "ppt"])
})

test("790 file-only optimistic queue cannot claim a running turn before its admitted event", async () => {
  const store = createServerSession(
    createZaovraClient({
      baseUrl: "http://fixed790.invalid",
      throwOnError: true,
      fetch: async () => Response.json({ data: session }),
    }),
  )
  await store.resolve(session.id)
  const initial = adapt([user("a-running", 1), answer("answer-a", 2)])
  store.set(
    "message",
    session.id,
    initial.map((item) => item.message).sort((a, b) => a.id.localeCompare(b.id)),
  )
  initial.forEach((item) => store.set("part", item.message.id, item.parts))
  store.set("session_status", session.id, { type: "busy" })
  const projection = createRoot((dispose) => {
    cleanups.push(dispose)
    return createTimelineProjection({
      messages: () => store.data.message[session.id] ?? [],
      userMessages: () => (store.data.message[session.id] ?? []).filter((item) => item.role === "user"),
      parts: (id) => store.data.part[id] ?? [],
      status: () => store.data.session_status[session.id] ?? { type: "idle" },
      showReasoningSummaries: () => true,
      inlineComments: () => false,
      pending: (id) => !!store.pendingDelivery(session.id, id),
    })
  })
  const input = {
    id: "b-file",
    timeCreated: 3,
    delivery: "queue" as const,
    prompt: {
      text: "",
      files: [
        { name: "demo.pptx", mime: "application/octet-stream", uri: "data:application/octet-stream;base64,Zml4ZWQ=" },
      ],
    },
  }
  const adapted = adaptSessionInput(session, input)
  const optimistic = { sessionID: session.id, ...adapted, delivery: input.delivery }
  store.optimistic.add(optimistic)
  expect(adapted.parts).toHaveLength(1)
  expect(adapted.parts[0].type).toBe("file")
  expect(store.pendingDelivery(session.id, input.id)).toBe("queue")
  expect(projection.activeMessageID()).toBe("a-running")
  store.apply({
    type: "session.next.prompted",
    properties: { sessionID: session.id, messageID: input.id, timestamp: 3, prompt: input.prompt },
  })
  expect(store.pendingDelivery(session.id, input.id)).toBeUndefined()
  expect(projection.activeMessageID()).toBe(input.id)
  store.optimistic.add(optimistic)
  expect(store.pendingDelivery(session.id, input.id)).toBeUndefined()
})
