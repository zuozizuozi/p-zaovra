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
const language = { locale: () => "zh", t: (key: string) => (dict as Record<string, string>)[key] ?? key }
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

test("766 fixed Customize entry follows the selected project without creating or navigating", async () => {
  const targets: unknown[] = []
  const host = document.createElement("main")
  document.body.append(host)
  disposals.push(render(() => <DesktopSidebar onCustomize={(target) => targets.push(target)} />, host))
  const entry = host.querySelector<HTMLButtonElement>('[data-action="customize"]')!
  expect(entry.textContent).toBe("自定义")
  expect(entry.closest("nav")).toBeNull()
  entry.click()
  expect(targets[0]).toEqual({ server: "local", directory: "F:/one" })
  const heading = host.querySelectorAll<HTMLElement>('[data-slot="project-heading"]')[1]!
  const button = heading.matches("button") ? heading : heading.querySelector<HTMLButtonElement>("button")!
  button.click()
  entry.click()
  expect(targets[1]).toEqual({ server: "local", directory: "F:/two" })
  expect(state.drafts).toBe(0)
  expect(state.navigations).toBe(0)
})
