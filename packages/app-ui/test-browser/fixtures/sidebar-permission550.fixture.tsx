import { expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { dict } from "../../src/i18n/zh"
import type { PermissionView } from "@zaovra-ai/sdk/v2/client"
import { ServerScope } from "../../src/utils/server-scope"
const language = {
  locale: () => "zh",
  t: (key: string, params?: Record<string, string>) =>
    ((dict as Record<string, string>)[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name) => params?.[name] ?? ""),
}
const [params, setParams] = createStore({ id: "ses_a" })
const [route, setRoute] = createStore({ type: "session", server: "fixture", sessionId: "ses_a" })
const [selection, setSelection] = createStore({ server: "fixture", directory: "/fixture/a" })
const [openTabs, setOpenTabs] = createStore([
  { type: "session", server: "fixture", sessionId: "ses_a" },
  { type: "session", server: "fixture", sessionId: "ses_b" },
  { type: "session", server: "fixture", sessionId: "ses_other" },
])
const [projects] = createStore([
  { id: "global", worktree: "/fixture/a", name: "Project A", expanded: true },
  { id: "project-b", worktree: "/fixture/b", name: "Project B", expanded: true },
])
const sessions = Object.fromEntries(
  ["a", "b", "other", "new", "closed"].map((id, i) => [
    "ses_" + id,
    {
      id: "ses_" + id,
      title: "Conversation " + id,
      directory: id === "other" ? "/elsewhere" : "/fixture/" + (id === "new" ? "a" : id),
      time: { created: i, updated: i },
    },
  ]),
)
sessions.ses_closed.directory = "/fixture/a"
const children = Object.fromEntries(
  projects.map((project) => [
    project.worktree,
    {
      project: project.id,
      config: { permission: { bash: "ask" } },
      session: project.worktree.endsWith("a") ? [sessions.ses_a, sessions.ses_closed] : [sessions.ses_b],
      limit: 20,
      sessionTotal: 2,
    },
  ]),
)
const listeners = new Set<(event: { name: string; details: { type: string; properties: PermissionView } }) => void>()
const replies: { requestID: string; reply: string }[] = []
const drafts: unknown[] = []
let pending: [] = []
const sync = {
  data: { project: projects },
  child: (directory: string) => [children[directory] ?? { config: {}, session: [] }],
  session: {
    data: { info: sessions, permission: {} },
    lineage: {
      peek: (id: string) => ({ session: sessions[id] }),
      resolve: async (id: string) => ({ session: sessions[id] }),
    },
    peek: (id: string) => sessions[id],
    resolve: async (id: string) => sessions[id],
  },
  project: { loadSessions: async () => {}, meta: () => {} },
}
const sdk = {
  scope: ServerScope.local,
  event: {
    listen: (callback: Parameters<typeof listeners.add>[0]) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  },
  client: {
    v2: {
      permission: { request: { list: async () => ({ data: { data: pending } }) } },
      session: {
        permission: {
          reply: async (input: { requestID: string; reply: string }) => {
            replies.push(input)
          },
        },
      },
    },
  },
}
const ctx = { sdk, sync, projects: { list: () => projects } }
const tabs = {
  store: openTabs,
  info: {},
  stateValue: () => undefined,
  rememberSessionInfo: () => {},
  select: (tab: typeof route) => setRoute(tab),
  newDraft: async (input: unknown) => {
    drafts.push(input)
  },
  closeTab: (index: number) => setOpenTabs((items) => items.filter((_, i) => i !== index)),
}
const layout = {
  route: () => route,
  home: { selection: () => selection, setSelection: (value: typeof selection) => setSelection(value) },
}
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@solidjs/router", () => ({
  useParams: () => params,
  useSearchParams: () => [{}],
  useNavigate: () => () => setRoute("type", "home"),
}))
mock.module("@/context/global", () => ({
  useGlobal: () => ({ servers: { list: () => [{ id: "fixture" }] }, ensureServerCtx: () => ctx }),
}))
mock.module("@/context/layout", () => ({ useLayout: () => layout }))
mock.module("@/context/tabs", () => ({
  useTabs: () => tabs,
  tabHref: (tab: { sessionId?: string }) => "/session/" + tab.sessionId,
  tabKey: (tab: { sessionId?: string }) => tab.sessionId,
}))
mock.module("@/context/server", () => ({
  useServer: () => ({ key: "fixture", scope: () => ServerScope.local }),
  ServerConnection: { key: () => "fixture" },
}))
mock.module("@/context/settings", () => ({ useSettings: () => ({ general: { newLayoutDesigns: () => true } }) }))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web", openLink: () => {} }) }))
mock.module("@/context/command", () => ({ useCommand: () => ({ trigger: () => {} }) }))
mock.module("@/components/project-glyph", () => ({ ProjectGlyph: () => <span data-slot="project-icon">▱</span> }))
mock.module("@/components/titlebar-tab-nav", () => ({
  TabNavItem: (props: {
    session: () => { title: string } | undefined
    fallbackTitle: string
    onNavigate: () => void
  }) => (
    <button data-slot="open-conversation" onClick={props.onNavigate}>
      {props.session()?.title ?? props.fallbackTitle}
    </button>
  ),
  DraftTabItem: () => <span>New draft</span>,
}))
mock.module("@zaovra-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: () => {} }) }))
const { DesktopSidebar } = await import("../../src/components/desktop-sidebar")
const { PermissionProvider, usePermission } = await import("../../src/context/permission")
const { PermissionModeControl } = await import("../../src/components/permission-mode-control")
const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

test("projects expand independently, active navigation reopens its group, other conversations never duplicate owned tabs", async () => {
  const host = document.createElement("main")
  document.body.append(host)
  const dispose = render(() => <DesktopSidebar />, host)
  try {
    await settle()
    expect(host.querySelectorAll("[data-slot=project-conversations]")).toHaveLength(2)
    const sections = host.querySelectorAll("[data-slot=sidebar-project]")
    const collapse = sections[1].querySelector<HTMLButtonElement>("button[aria-expanded]")!
    collapse.click()
    await settle()
    expect(host.querySelectorAll("[data-slot=project-conversations]")).toHaveLength(1)
    expect(sections[0].textContent).toContain("Conversation a")
    expect(sections[0].textContent).toContain("Conversation closed")
    const other = host.querySelector("[data-slot=sidebar-recent]")!
    expect(other.textContent).toContain("其他对话")
    expect(other.textContent).toContain("Conversation other")
    expect(other.textContent).not.toContain("Conversation a")
    expect(other.textContent).not.toContain("Conversation b")
    setRoute("sessionId", "ses_b")
    await settle()
    expect(host.querySelectorAll("[data-slot=project-conversations]")).toHaveLength(2)
    expect(host.querySelector("[data-slot=new-session-project]")?.textContent).toContain("Project B")
    const newChat = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "新对话",
    )!
    newChat.click()
    await settle()
    expect(drafts.at(-1)).toEqual({ server: "fixture", directory: "/fixture/b" })
  } finally {
    dispose()
    host.remove()
  }
})

test("three permission choices persist by project across new sessions/remount and full mode shows risk, automatic keeps external requests visible", async () => {
  const host = document.createElement("main")
  document.body.append(host)
  let api: ReturnType<typeof usePermission>
  const Probe = () => {
    api = usePermission()
    return (
      <PermissionModeControl
        mode={api.mode("/fixture/a", params.id)}
        onChange={(mode) => api.setMode("/fixture/a", mode)}
      />
    )
  }
  const mount = () =>
    render(
      () => (
        <I18nProvider value={language}>
          <PermissionProvider>
            <Probe />
          </PermissionProvider>
        </I18nProvider>
      ),
      host,
    )
  let dispose = mount()
  try {
    await settle()
    api!.setMode("/fixture/a", "full")
    await settle()
    expect(host.querySelector("[data-slot=full-access-warning]")?.textContent).toContain("不再询问")
    expect(
      api!.autoResponds(
        { sessionID: "ses_a", permission: "external_directory", metadata: {} } as PermissionView,
        "/fixture/a",
      ),
    ).toBe(true)
    api!.setMode("/fixture/a", "automatic")
    await settle()
    expect(host.querySelector("[data-slot=full-access-warning]")).toBeNull()
    setParams("id", "ses_new")
    await settle()
    expect(api!.mode("/fixture/a", "ses_new")).toBe("automatic")
    expect(api!.mode("/fixture/b", "ses_b")).toBe("ask")
    const request: PermissionView = {
      id: "per_550",
      sessionID: "ses_new",
      permission: "bash",
      patterns: ["fixture"],
      always: ["fixture"],
      metadata: { externalRisk: false, preflight: "uncertain" },
    }
    expect(api!.autoResponds(request, "/fixture/a")).toBe(true)
    expect(api!.autoResponds({ ...request, permission: "external_directory" }, "/fixture/a")).toBe(false)
    expect(api!.autoResponds({ ...request, metadata: { externalRisk: true } }, "/fixture/a")).toBe(false)
    listeners.forEach((listener) =>
      listener({ name: "/fixture/a", details: { type: "permission.asked", properties: request } }),
    )
    await settle()
    expect(replies.at(-1)).toMatchObject({ requestID: "per_550", reply: "once" })
    dispose()
    await settle()
    expect(listeners.size).toBe(0)
    dispose = mount()
    await settle()
    expect(api!.mode("/fixture/a", "ses_new")).toBe("automatic")
    api!.setMode("/fixture/a", "ask")
    await settle()
    expect(api!.autoResponds(request, "/fixture/a")).toBe(false)
  } finally {
    dispose()
    host.remove()
  }
})
