import { afterEach, expect, test } from "bun:test"
import { createComponent, untrack, type JSX } from "solid-js"
import { render } from "solid-js/web"
import type { SessionMessage, SessionV2Info, ZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { createServerSession } from "../src/context/server-session"
import { createServerNotificationState } from "../src/context/notification"
import { PlatformProvider, type Platform } from "../src/context/platform"
import { ServerScope } from "@/utils/server-scope"

const roots: (() => void)[] = []
let sequence = 0

afterEach(() => {
  roots.splice(0).forEach((dispose) => dispose())
  localStorage.clear()
})

const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function setup(parentID?: string) {
  const id = "ses_recovery"
  const scope = ServerScope.fromServerKey(
    ("http://notification-test/" + sequence++) as Parameters<typeof ServerScope.fromServerKey>[0],
  )
  const session: SessionV2Info = {
    id,
    parentID,
    projectID: "project",
    title: "Recovery",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: { directory: "/repo" },
    time: { created: 1, updated: 1 },
  }
  const pages = { messages: [{ id: "msg_1", type: "user", text: "Run", time: { created: 1 } }] as SessionMessage[] }
  const ownership = { busy: false }
  const client = {
    v2: {
      session: {
        get: async () => ({ data: { data: session } }),
        messages: async () => ({ data: { data: pages.messages, cursor: {} } }),
        pendingInputs: async () => ({ data: { data: [] } }),
        interrupt: async () => {},
        wait: async () => {},
        active: async () => ({ data: { data: ownership.busy ? { [id]: { type: "running" } } : {} } }),
      },
      question: { request: { list: async () => ({ data: { data: [] } }) } },
      permission: { request: { list: async () => ({ data: { data: [] } }) } },
    },
  } as unknown as ZaovraClient
  const store = createServerSession(client)
  await store.sync(id)
  const listeners = new Set<
    (event: { name: string; details: { type: string; properties: { sessionID: string } } }) => void
  >()
  const notices: string[] = []
  const platform: Platform = {
    platform: "web",
    openLink() {},
    restart: async () => {},
    back() {},
    forward() {},
    notify: async (title) => {
      notices.push(title)
    },
  }
  const input = {
    sdk: {
      scope,
      event: {
        listen: (listener: Parameters<typeof listeners.add>[0]) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    },
    key: "sidecar",
    permission: { autoResponds: () => false },
    sync: { session: store, ensureDirSyncContext: () => ({ session: { get: store.get, sync: store.sync } }) },
    active: () => false,
    directory: () => "/elsewhere",
    sessionID: () => undefined,
    platform,
    settings: {
      sounds: { agentEnabled: () => false, errorsEnabled: () => false },
      notifications: { agent: () => true },
    },
    language: { t: (key: string) => key },
  } as unknown as Parameters<typeof createServerNotificationState>[0]
  const mounted = {
    state: undefined as ReturnType<typeof createServerNotificationState> | undefined,
    dispose: () => {},
  }
  const mount = () => {
    const dispose = render(
      () =>
        createComponent(PlatformProvider, {
          value: platform,
          get children() {
            return (() =>
              untrack(() => {
                mounted.state = createServerNotificationState(input)
                return null
              })) as unknown as JSX.Element
          },
        }),
      document.createElement("div"),
    )
    roots.push(dispose)
    mounted.dispose = dispose
    if (!mounted.state) throw new Error("Notification state did not mount")
    return mounted.state
  }
  const state = mount()
  await settle()
  const status = (type: "busy" | "idle") =>
    store.apply({ type: "session.status", properties: { sessionID: id, status: { type } } })
  const event = (type: string) =>
    listeners.forEach((listen) => listen({ name: "/repo", details: { type, properties: { sessionID: id } } }))
  const complete = async (error = false) => {
    pages.messages = [
      ...pages.messages,
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: session.model!,
        time: { created: 2, completed: 3 },
        finish: "stop",
        content: [{ type: "text", id: "text", text: "Done" }],
        ...(error ? { error: { type: "unknown", message: "Failed", metadata: {} } } : {}),
      } as Extract<SessionMessage, { type: "assistant" }>,
    ]
    await store.sync(id, { force: true })
    await settle()
  }
  const resetStore = () => {
    const next = createServerSession(client)
    input.sync.session = next
    input.sync.ensureDirSyncContext = (() => ({
      session: { get: next.get, sync: next.sync },
    })) as unknown as typeof input.sync.ensureDirSyncContext
    return next
  }
  return { id, store, state, mounted, mount, status, event, complete, notices, pages, session, ownership, resetStore }
}

test("237 recovers a successful idle snapshot when the end event was missed", async () => {
  const ctx = await setup()
  ctx.status("busy")
  await settle()
  await ctx.complete()
  expect(ctx.state.session.unseenCount(ctx.id)).toBe(0)
  ctx.status("idle")
  await settle()
  expect(ctx.state.session.unseenCount(ctx.id)).toBe(1)
  expect(ctx.state.project.unseenCount("/repo")).toBe(1)
  expect(ctx.notices).toHaveLength(1)
})

test("237 retains the completion candidate across notification root recreation before idle", async () => {
  const ctx = await setup()
  ctx.status("busy")
  ctx.event("session.next.step.ended")
  await ctx.complete()
  ctx.mounted.dispose()
  const restored = ctx.mount()
  await settle()
  ctx.status("idle")
  await settle()
  expect(restored.session.unseenCount(ctx.id)).toBe(1)
  expect(ctx.notices).toHaveLength(1)
})

test("237 normal multi-step completion remains one notification and viewed state survives recreation", async () => {
  const ctx = await setup()
  ctx.status("busy")
  ctx.event("session.next.step.ended")
  ctx.event("session.next.step.ended")
  await ctx.complete()
  expect(ctx.state.session.unseenCount(ctx.id)).toBe(0)
  ctx.status("idle")
  await settle()
  expect(ctx.state.session.unseenCount(ctx.id)).toBe(1)
  expect(ctx.notices).toHaveLength(1)
  ctx.state.session.markViewed(ctx.id)
  expect(ctx.state.project.unseenCount("/repo")).toBe(0)
  ctx.mounted.dispose()
  const restored = ctx.mount()
  await settle()
  expect(restored.session.unseenCount(ctx.id)).toBe(0)
  expect(ctx.notices).toHaveLength(1)
})

test("237 does not turn pre-existing idle history into a new unread notification", async () => {
  const ctx = await setup()
  await ctx.complete()
  ctx.status("idle")
  await settle()
  expect(ctx.state.session.unseenCount(ctx.id)).toBe(0)
  expect(ctx.notices).toHaveLength(0)
})

for (const terminal of ["session.next.step.failed", "session.next.deleted"])
  test("237 " + terminal + " discards a queued success notification", async () => {
    const ctx = await setup()
    ctx.status("busy")
    ctx.event("session.next.step.ended")
    ctx.event(terminal)
    await ctx.complete()
    ctx.status("idle")
    await settle()
    expect(ctx.state.session.unseenCount(ctx.id)).toBe(0)
    expect(ctx.notices).toHaveLength(0)
  })

test("237 does not notify completed child sessions", async () => {
  const ctx = await setup("ses_parent")
  ctx.status("busy")
  ctx.event("session.next.step.ended")
  await ctx.complete()
  ctx.status("idle")
  await settle()
  expect(ctx.state.session.unseenCount(ctx.id)).toBe(0)
  expect(ctx.notices).toHaveLength(0)
})

test("237 an error snapshot cannot be recovered as a successful turn", async () => {
  const ctx = await setup()
  ctx.status("busy")
  await ctx.complete(true)
  ctx.status("idle")
  await settle()
  expect(ctx.state.session.unseenCount(ctx.id)).toBe(0)
  expect(ctx.notices).toHaveLength(0)
})

test("237 reloads missing history before recovering a persisted idle candidate", async () => {
  const ctx = await setup()
  ctx.status("busy")
  await ctx.complete()
  ctx.store.set("message", (previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== ctx.id)))
  ctx.status("idle")
  await settle()
  expect(ctx.state.session.unseenCount(ctx.id)).toBe(1)
  expect(ctx.notices).toHaveLength(1)
})

test("237 recreation during the idle lookup does not lose the persisted candidate", async () => {
  const ctx = await setup()
  ctx.status("busy")
  await ctx.complete()
  ctx.status("idle")
  ctx.mounted.dispose()
  const restored = ctx.mount()
  await settle()
  expect(restored.session.unseenCount(ctx.id)).toBe(1)
  expect(ctx.notices).toHaveLength(1)
})

test("237 a new busy ownership invalidates the pending idle notification without losing recovery", async () => {
  const ctx = await setup()
  ctx.status("busy")
  await ctx.complete()
  ctx.status("idle")
  ctx.status("busy")
  await settle()
  expect(ctx.state.session.unseenCount(ctx.id)).toBe(0)
  expect(ctx.notices).toHaveLength(0)
  ctx.status("idle")
  await settle()
  expect(ctx.state.session.unseenCount(ctx.id)).toBe(1)
  expect(ctx.notices).toHaveLength(1)
})

test("237 confirmed Stop does not recover success from a late completed snapshot", async () => {
  const ctx = await setup()
  await ctx.complete()
  ctx.pages.messages.push({ id: "msg_3", type: "user", text: "Next", time: { created: 4 } })
  await ctx.store.sync(ctx.id, { force: true })
  ctx.status("busy")
  await ctx.store.interrupt(ctx.id)
  expect(ctx.store.stopped("msg_3")).toBe(true)
  ctx.pages.messages.push({
    id: "msg_4",
    type: "assistant",
    agent: "build",
    model: ctx.session.model!,
    time: { created: 5, completed: 6 },
    finish: "stop",
    content: [{ type: "text", id: "text", text: "Late snapshot" }],
  })
  await ctx.store.sync(ctx.id, { force: true })
  await settle()
  expect(ctx.state.session.unseenCount(ctx.id)).toBe(0)
  expect(ctx.notices).toHaveLength(0)
})

test("237 restores the persisted candidate after the session store itself is recreated", async () => {
  const ctx = await setup()
  ctx.status("busy")
  await ctx.complete()
  ctx.mounted.dispose()
  const reopened = ctx.resetStore()
  const restored = ctx.mount()
  await settle()
  expect(reopened.data.session_status[ctx.id]?.type).toBe("idle")
  expect(restored.session.unseenCount(ctx.id)).toBe(1)
  expect(ctx.notices).toHaveLength(1)
})

test("237 a restored candidate waits for authoritative busy ownership to finish", async () => {
  const ctx = await setup()
  ctx.status("busy")
  await ctx.complete()
  ctx.mounted.dispose()
  ctx.ownership.busy = true
  const reopened = ctx.resetStore()
  const restored = ctx.mount()
  await settle()
  expect(reopened.data.session_status[ctx.id]?.type).toBe("busy")
  expect(restored.session.unseenCount(ctx.id)).toBe(0)
  ctx.ownership.busy = false
  await reopened.resync(ctx.id)
  await settle()
  expect(restored.session.unseenCount(ctx.id)).toBe(1)
  expect(ctx.notices).toHaveLength(1)
})
