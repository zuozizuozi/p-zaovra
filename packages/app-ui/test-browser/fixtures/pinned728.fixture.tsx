import { expect, mock, test } from "bun:test"
import { ErrorBoundary, For } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { PlatformProvider } from "../../src/context/platform"
import { LanguageProvider } from "../../src/context/language"
import { ServerConnection, ServerProvider } from "../../src/context/server"
import { createPinnedSessions, type PinnedSession } from "../../src/utils/sidebar-session-preferences"
import type { Session } from "@zaovra-ai/sdk/v2/client"

const server = ServerConnection.Key.make("http://pin728-a")
const other = ServerConnection.Key.make("http://pin728-b")
const [state, setState] = createStore<{ pins: PinnedSession[]; archived: boolean; deleted: boolean }>({
  pins: [],
  archived: false,
  deleted: false,
})
const pins = createPinnedSessions({ read: () => state.pins, write: (items) => setState("pins", items) })
const session = {
  id: "same728",
  title: "Pinned real session",
  directory: "F:/synthetic728",
  time: { created: 1, updated: 2 },
} as Session
const servers: ServerConnection.Any[] = [server, other].map((url) => ({ type: "http", http: { url } }))
const ctx = {
  projects: { list: () => [] },
  sync: {
    data: { path: { home: "" } },
    session: {
      peek: () =>
        state.deleted ? undefined : { ...session, time: { ...session.time, archived: state.archived ? 3 : undefined } },
      resolve: async () => (state.deleted ? undefined : session),
    },
  },
}
mock.module("../../src/context/global", () => ({
  useGlobal: () => ({ servers: { list: () => servers }, ensureServerCtx: () => ctx }),
}))
// Avatar attention services are outside the tab-cache feedback boundary.
mock.module("@/pages/layout/project-avatar-state", () => ({
  useSessionTabAvatarState: () => ({
    unread: () => false,
    loading: () => false,
    status: () => "session.activity.idle",
  }),
}))
const layout = await import("../../src/context/layout")
mock.module("../../src/context/layout", () => ({ ...layout, useLayout: () => ({ pins }) }))
// These actions' dialogs/network are outside the cache feedback path under test.
mock.module("../../src/components/sidebar-session-actions", () => ({ SidebarSessionActions: () => null }))
mock.module("../../src/pages/layout/session-tab-avatar", () => ({ SessionTabAvatar: () => null }))
const { TabsProvider, useTabs, tabKey } = await import("../../src/context/tabs")
const { DesktopSessionTab } = await import("../../src/components/desktop-sidebar")
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test("728 actual TabsProvider and pinned sidebar rows settle through pin/open/close/restore/unpin/archive/delete/server boundaries", async () => {
  localStorage.clear()
  const errors: string[] = []
  let tabs!: ReturnType<typeof useTabs>
  let steps = 0
  let navigations = 0
  const root = document.createElement("div")
  document.body.append(root)
  function Rows() {
    tabs = useTabs()
    const remember = tabs.rememberSessionInfo
    tabs.rememberSessionInfo = (...args) => {
      if (++steps > 40) throw new Error("728 bounded guard: tab cache feedback did not settle")
      remember(...args)
    }
    return (
      <>
        <For each={pins.list()}>
          {(pin) => (
            <DesktopSessionTab
              pinned
              tab={{ type: "session", server: pin.server, sessionId: pin.sessionID }}
              active={() => false}
              serverCtx={() => ctx as never}
              onClose={() => pins.remove(pin.server, pin.sessionID)}
              onNavigate={() => navigations++}
            />
          )}
        </For>
        <button data-continue onClick={() => navigations++}>
          Continue
        </button>
      </>
    )
  }
  const dispose = render(
    () => (
      <PlatformProvider
        value={{
          platform: "web",
          openLink() {},
          restart: async () => {},
          back() {},
          forward() {},
          notify: async () => {},
        }}
      >
        <LanguageProvider locale="en">
          <ServerProvider defaultServer={server} servers={servers}>
            <MemoryRouter>
              <Route
                path="*"
                component={() => (
                  <TabsProvider>
                    <ErrorBoundary
                      fallback={(error) => {
                        errors.push(String(error))
                        return <div data-error>{String(error)}</div>
                      }}
                    >
                      <Rows />
                    </ErrorBoundary>
                  </TabsProvider>
                )}
              />
            </MemoryRouter>
          </ServerProvider>
        </LanguageProvider>
      </PlatformProvider>
    ),
    root,
  )
  const tab = { type: "session" as const, server, sessionId: session.id }
  const second = { ...tab, server: other }
  async function settled() {
    await tick()
    expect(errors).toEqual([])
    expect(steps).toBeLessThan(40)
    root.querySelector<HTMLButtonElement>("[data-continue]")!.click()
    expect(navigations).toBeGreaterThan(0)
  }
  try {
    await tick()
    pins.toggle(server, session)
    await settled()
    expect(tabs.info[tabKey(tab)]).toBeUndefined()
    expect(root.textContent).toContain(session.title)
    tabs.addSessionTab(tab)
    await settled()
    expect(tabs.info[tabKey(tab)]?.title).toBe(session.title)
    tabs.removeSessionTab(tab)
    await settled()
    expect(pins.has(server, session.id)).toBe(true)
    expect(tabs.info[tabKey(tab)]).toBeUndefined()
    pins.remove(server, session.id)
    await settled()
    // Restore the persisted-pin shape with no corresponding open tab.
    setState("pins", [{ server, sessionID: session.id, directory: session.directory }])
    await settled()
    expect(tabs.info[tabKey(tab)]).toBeUndefined()
    pins.toggle(other, session)
    tabs.addSessionTab(second)
    await settled()
    expect(pins.list()).toHaveLength(2)
    expect(tabs.info[tabKey(second)]?.title).toBe(session.title)
    expect(tabs.info[tabKey(tab)]).toBeUndefined()
    pins.remove(server, session.id)
    await settled()
    expect(pins.has(other, session.id)).toBe(true)
    setState("archived", true)
    await settled()
    expect(pins.list()).toHaveLength(0)
    setState("archived", false)
    pins.toggle(other, session)
    await settled()
    // The production archive/delete path owns removal of both row and tab.
    setState("deleted", true)
    pins.remove(other, session.id)
    tabs.removeSessions({ server: other, directory: session.directory, sessionIDs: [session.id] })
    await settled()
    expect(tabs.store).toHaveLength(0)
    expect(Object.keys(tabs.info)).toHaveLength(0)
  } finally {
    dispose()
    root.remove()
    setState({ pins: [], archived: false, deleted: false })
  }
})
