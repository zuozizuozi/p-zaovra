import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { dict } from "../../src/i18n/en"

const [state, setState] = createStore({
  selection: { server: "local", directory: "F:/one" },
  route: { type: "home", sessionId: "", server: "local", draftID: "" },
  drafts: 0,
  navigations: 0,
  projectOrder: [] as string[],
  sessionOrder: {} as Record<string, string[]>,
  pins: [] as Array<{ server: string; sessionID: string; directory: string }>,
  sessions: [
    { id: "old", directory: "F:/one", title: "Old", time: { created: 1, updated: 5 } },
    { id: "new", directory: "F:/one", title: "New", time: { created: 2, updated: 4 } },
  ],
})
const [tabs, setTabs] = createStore<
  Array<{ type: "session" | "draft"; server: string; sessionId?: string; directory?: string; draftID?: string }>
>([])
const language = { t: (key: string) => (dict as Record<string, string>)[key] ?? key }
const projects = [
  { worktree: "F:/one", name: "One" },
  { worktree: "F:/two", name: "Two" },
]
const key = (tab: { server: string; sessionId?: string }) => `${tab.server}:${tab.sessionId}`
const ctx = {
  projects: { list: () => projects },
  sync: {
    session: {
      peek: (id: string) => state.sessions.find((s) => s.id === id),
      resolve: async (id: string) => state.sessions.find((s) => s.id === id),
    },
    child: (directory: string) => [
      { session: state.sessions.filter((s) => s.directory === directory), sessionTotal: 2, limit: 20 },
    ],
    project: { loadSessions: async () => {} },
  },
}
mock.module("@solidjs/router", () => ({ useNavigate: () => () => setState("navigations", (n) => n + 1) }))
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/command", () => ({ useCommand: () => ({ trigger: () => {} }) }))
mock.module("@/context/global", () => ({
  useGlobal: () => ({ servers: { list: () => [{ key: "local" }] }, ensureServerCtx: () => ctx }),
}))
mock.module("@/context/server", () => ({
  ServerConnection: { key: (connection: { key: string }) => connection.key, local: () => true },
}))
mock.module("@/context/layout", () => ({
  useLayout: () => ({
    route: () => state.route,
    home: {
      selection: () => state.selection,
      setSelection: (selection: typeof state.selection) => setState("selection", selection),
    },
    sidebar: {
      projectOrder: () => state.projectOrder,
      setProjectOrder: (order: string[]) => setState("projectOrder", order),
      sessionOrder: (group: string) => state.sessionOrder[group] ?? [],
      setSessionOrder: (group: string, order: string[]) => setState("sessionOrder", group, order),
    },
    pins: {
      list: () => state.pins,
      has: (server: string, id: string) => state.pins.some((p) => p.server === server && p.sessionID === id),
      remove: () => {},
      reorder: (order: string[]) =>
        setState(
          "pins",
          order.flatMap((id) => state.pins.filter((p) => `${p.server}:${p.sessionID}` === id)),
        ),
    },
  }),
}))
mock.module("@/context/tabs", () => ({
  tabKey: key,
  tabHref: () => "/session",
  useTabs: () => ({
    store: tabs,
    info: {},
    stateValue: () => ({ ready: () => true, dirty: () => false, context: { items: () => [] } }),
    newDraft: async (input: { server: string; directory: string }) => {
      setState("drafts", (n) => n + 1)
      setTabs([...tabs, { type: "draft", ...input, draftID: "draft" }])
      setState("route", { type: "draft", draftID: "draft" })
    },
    rememberSessionInfo: () => {},
    select: () => {},
  }),
}))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "desktop", os: "windows" }) }))
mock.module("@/components/project-glyph", () => ({ ProjectGlyph: () => <span>Project</span> }))
mock.module("@/pages/layout/helpers", () => ({ displayName: (project: { name: string }) => project.name }))
mock.module("@/components/titlebar-tab-nav", () => ({
  DraftTabItem: () => <div data-fixture="draft">Draft</div>,
  TabNavItem: (props: { session: () => { id: string; title: string } | undefined }) => (
    <div data-fixture-session={props.session()?.id}>{props.session()?.title}</div>
  ),
}))
mock.module("@/components/sidebar-session-actions", () => ({ SidebarSessionActions: () => null }))
const { DesktopSidebar } = await import("../../src/components/desktop-sidebar")
const disposals: Array<() => void> = []
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  setTabs([])
  setState({
    selection: { server: "local", directory: "F:/one" },
    route: { type: "home", sessionId: "" },
    drafts: 0,
    navigations: 0,
    projectOrder: [],
    sessionOrder: {},
    pins: [],
  })
})
function mount() {
  const host = document.createElement("main")
  document.body.append(host)
  const dispose = render(() => <DesktopSidebar />, host)
  return { host, dispose }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
function drop(source: HTMLElement, target: HTMLElement) {
  const values = new Map<string, string>()
  const dataTransfer = {
    types: ["application/x-zaovra-sidebar"],
    setData: (key: string, value: string) => values.set(key, value),
    getData: (key: string) => values.get(key) ?? "",
  }
  const start = new Event("dragstart", { bubbles: true, cancelable: true })
  Object.defineProperty(start, "dataTransfer", { value: dataTransfer })
  source.dispatchEvent(start)
  const end = new Event("drop", { bubbles: true, cancelable: true })
  Object.defineProperty(end, "dataTransfer", { value: dataTransfer })
  target.dispatchEvent(end)
}
if (process.env.ZAOVRA_SIDEBAR_BENCH === "1") {
  test("766 actual sidebar mount/dispose CPU", () => {
    const samples = Array.from({ length: 13 }, () => {
      const start = performance.now()
      for (let n = 0; n < 20; n++) {
        const value = mount()
        value.dispose()
        document.body.replaceChildren()
      }
      return performance.now() - start
    })
    console.log(
      JSON.stringify({
        benchmark: "766 actual DesktopSidebar mount/dispose",
        mountsPerSample: 20,
        samples,
        medianMs: samples.slice(2).toSorted((a, b) => a - b)[5],
        scope: "two projects/two sessions; child visual primitives and app services are fixtures",
      }),
    )
  })
} else {
  test("766 project heading toggles and selects without navigation or draft", async () => {
    const value = mount()
    disposals.push(value.dispose)
    await settle()
    const heading = value.host.querySelector<HTMLElement>('[data-slot="project-heading"]')!
    const target = heading.matches("button") ? heading : heading.querySelector<HTMLElement>("button")!
    target.click()
    await settle()
    expect(state.navigations).toBe(0)
    expect(state.drafts).toBe(0)
    expect(target.closest("section")!.querySelector('[data-slot="project-conversations"]')).toBeNull()
    target.click()
    await settle()
    expect(target.closest("section")!.querySelector('[data-slot="project-conversations"]')).not.toBeNull()
  })
  test("766 explicit new draft remains outside sidebar until admission", async () => {
    const value = mount()
    disposals.push(value.dispose)
    await settle()
    value.host.querySelector<HTMLElement>('[data-slot="project-action"]')!.click()
    await settle()
    expect(state.drafts).toBe(1)
    expect(value.host.querySelector('[data-fixture="draft"]')).toBeNull()
  })
  test("766 actual drag handlers reorder projects, sessions and pins within their own lists", async () => {
    setState("pins", [
      { server: "local", sessionID: "pin-a", directory: "F:/one" },
      { server: "local", sessionID: "pin-b", directory: "F:/one" },
    ])
    const value = mount()
    disposals.push(value.dispose)
    await settle()
    const row = (id: string) =>
      [...value.host.querySelectorAll<HTMLElement>('[data-slot="sidebar-reorder"]')].find(
        (node) => node.dataset.reorderId === id,
      )!
    drop(row("local:F:/one"), row("local:F:/two"))
    await settle()
    expect(state.projectOrder).toEqual(["local:F:/two", "local:F:/one"])
    drop(row("new"), row("old"))
    await settle()
    expect(state.sessionOrder["local:F:/one"]).toEqual(["old", "new"])
    drop(row("local:pin-a"), row("local:pin-b"))
    await settle()
    expect(state.pins.map((pin) => pin.sessionID)).toEqual(["pin-b", "pin-a"])
    drop(row("old"), row("local:F:/two"))
    await settle()
    expect(state.projectOrder).toEqual(["local:F:/two", "local:F:/one"])
  })
  test("766 keyboard reorder and promoted session are reflected in the actual list", async () => {
    const value = mount()
    disposals.push(value.dispose)
    await settle()
    const sessionRow = value.host.querySelector<HTMLElement>('[data-reorder-id="new"]')!
    sessionRow.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }),
    )
    await settle()
    expect(state.sessionOrder["local:F:/one"]).toEqual(["old", "new"])
    setState("sessions", [
      ...state.sessions,
      { id: "admitted", directory: "F:/one", title: "Admitted", time: { created: 3, updated: 3 } },
    ])
    setTabs([{ type: "session", server: "local", sessionId: "admitted" }])
    await settle()
    const group = value.host.querySelector('[data-reorder-id="old"]')!.closest('[data-slot="project-conversations"]')!
    expect(
      [...group.querySelectorAll<HTMLElement>("[data-fixture-session]")].map((node) => node.dataset.fixtureSession),
    ).toEqual(["admitted", "old", "new"])
    setState("sessions", (sessions) => sessions.filter((session) => session.id !== "admitted"))
  })
}
