import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { dict } from "../../../desktop-app/src/renderer/i18n/zh"
import { dict as appDict } from "../../src/i18n/zh"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
const calls = {
  sidebar: 0,
  restored: 0,
  loaded: 0,
  touched: [] as string[],
  drafts: [] as Array<{ server: string; directory: string }>,
  selected: [] as string[],
  picker: 0,
  opened: [] as string[],
  finished: [] as boolean[],
  check: 0,
  download: 0,
  install: 0,
}
const [state, setState] = createStore({
  directoryAvailable: true,
  existingInstall: false,
  pending: true,
  projects: [] as Array<{ worktree: string }>,
  tabs: [] as string[],
  channel: "beta",
  update: { status: "idle" } as import("../../src/updater").UpdaterState,
})
const language = { locale: () => "zh", t: (key: string) => (appDict as Record<string, string>)[key] ?? key }
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    platform: "desktop",
    get channel() {
      return state.channel
    },
    legalDocument: async () => await Bun.file("../desktop-app/resources/licenses/Zaovra-MIT.txt").text(),
    updater: {
      state: () => state.update,
      check: async () => {
        calls.check++
        return state.update
      },
      download: async () => {
        calls.download++
        return state.update
      },
      install: async () => {
        calls.install++
      },
    },
  }),
}))
mock.module("../../../desktop-app/src/renderer/i18n", () => ({
  t: (key: string) => (dict as Record<string, string>)[key] ?? key,
}))
mock.module("@zaovra-ai/app", () => ({
  ServerConnection: { builtin: () => true, key: () => "local" },
  useLayout: () => ({
    ready: { promise: Promise.resolve() },
    sidebar: { open: () => calls.sidebar++ },
  }),
  useSettings: () => ({ general: { setOldLayoutEligible: () => {} } }),
  useServer: () => ({
    ready: { promise: Promise.resolve() },
    isLocal: () => true,
    list: [],
    key: "local",
    projects: {
      list: () => state.projects,
      open: (path: string) => calls.opened.push(path),
      touch: (path: string) => calls.touched.push(path),
    },
  }),
  useTabs: () => ({
    ready: { promise: Promise.resolve() },
    recentReady: { promise: Promise.resolve() },
    get store() {
      return state.tabs
    },
    toggleHome: () => calls.restored++,
    newDraft: async (input: { server: string; directory: string }) => {
      calls.drafts.push(input)
      return "draft"
    },
    select: (tab: string) => calls.selected.push(tab),
  }),
}))
const disposals: Array<() => void> = []
afterEach(() => {
  disposals.splice(0).forEach((d) => d())
  document.body.replaceChildren()
  setState({
    directoryAvailable: true,
    existingInstall: false,
    pending: true,
    projects: [],
    tabs: [],
    channel: "beta",
    update: { status: "idle" },
  })
  calls.restored = 0
  calls.sidebar = calls.loaded = calls.picker = calls.check = calls.download = calls.install = 0
  calls.opened.length = calls.touched.length = calls.drafts.length = calls.selected.length = calls.finished.length = 0
})
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!
const settle = () => new Promise((r) => setTimeout(r, 30))
async function mountOnboarding() {
  Object.assign(window, {
    api: {
      isOldLayoutEligible: async () => state.existingInstall,
      isFirstLaunchOnboardingPending: async () => state.pending,
      finishFirstLaunchOnboarding: async (create: boolean) => {
        calls.finished.push(create)
        if (!create) return null
        return state.directoryAvailable ? { directory: "F:/synthetic/Default Project" } : { needsDirectory: true }
      },
      openDirectoryPicker: async () => {
        calls.picker++
        return "F:/synthetic-project"
      },
    },
  })
  const { DesktopFirstLaunchOnboarding } = await import("../../../desktop-app/src/renderer/onboarding")
  const host = document.createElement("main")
  document.body.append(host)
  disposals.push(render(() => <DesktopFirstLaunchOnboarding initialUrl="/" onLoaded={() => calls.loaded++} />, host))
  await settle()
}

test("659 fresh desktop opens the default project and draft without a model prerequisite", async () => {
  await mountOnboarding()
  expect(calls.opened).toEqual(["F:/synthetic/Default Project"])
  expect(calls.touched).toEqual(calls.opened)
  expect(calls.drafts).toEqual([{ server: "local", directory: "F:/synthetic/Default Project" }])
  expect(calls.selected).toEqual(["draft"])
  expect(calls.sidebar).toBe(1)
  expect(calls.finished).toEqual([true])
  expect(calls.loaded).toBe(1)
  expect(calls.picker).toBe(0)
  expect(document.querySelector('[role="status"]')).toBeNull()
  expect(document.body.textContent).not.toContain("先连接模型服务")
  expect(document.body.textContent).not.toContain("不可用")
  expect(document.body.textContent).not.toContain("gpt-6-luna")
})

test("659 failed default directories offer an enabled folder picker without a model prerequisite", async () => {
  setState("directoryAvailable", false)
  await mountOnboarding()
  expect(document.querySelector('[role="status"]')?.textContent).toContain("无法创建默认项目，请选择文件夹。")
  expect(document.body.textContent).not.toContain("先连接模型服务")
  expect(document.body.textContent).not.toContain("gpt-6-luna")
  expect(calls.opened).toEqual([])
  expect(calls.picker).toBe(0)
  expect(button("选择文件夹").disabled).toBe(false)
  button("选择文件夹").click()
  await settle()
  expect(calls.opened).toEqual(["F:/synthetic-project"])
  expect(calls.touched).toEqual(calls.opened)
  expect(calls.drafts).toEqual([{ server: "local", directory: "F:/synthetic-project" }])
  expect(calls.selected).toEqual(["draft"])
  expect(calls.sidebar).toBe(1)
  expect(calls.finished).toEqual([true, false])
  expect(calls.loaded).toBe(1)
  expect(document.querySelector('[role="status"]')).toBeNull()
})

test("659 an existing installation does not create a project or change the sidebar", async () => {
  setState("existingInstall", true)
  setState("projects", [{ worktree: "F:/synthetic/existing" }])
  await mountOnboarding()
  expect(calls.finished).toEqual([false])
  expect(calls.opened).toEqual([])
  expect(calls.drafts).toEqual([])
  expect(calls.selected).toEqual([])
  expect(calls.sidebar).toBe(0)
  expect(calls.picker).toBe(0)
  expect(calls.loaded).toBe(1)
  expect(document.querySelector('[role="status"]')).toBeNull()
})
test("612 actual About updater shows failures, progress and restart action; hides dev", async () => {
  const { SettingsAbout } = await import("../../src/components/settings-v2/about")
  const host = document.createElement("main")
  document.body.append(host)
  disposals.push(
    render(
      () => (
        <I18nProvider value={language}>
          <SettingsAbout />
        </I18nProvider>
      ),
      host,
    ),
  )
  await settle()
  const entry = () => document.querySelector('[data-component="about-updater"]')!
  expect(entry()).toBeTruthy()
  button(language.t("settings.updates.action.checkNow")).click()
  await settle()
  expect(calls.check).toBe(1)
  setState("update", { status: "error", message: "Exact failure reason" })
  await settle()
  expect(entry().textContent).toContain("Exact failure reason")
  setState("update", { status: "downloading", version: "1.0", percent: 61 })
  await settle()
  expect(entry().textContent).toContain("61%")
  setState("update", { status: "ready", version: "1.0" })
  await settle()
  button(language.t("toast.update.action.installRestart")).click()
  await settle()
  expect(calls.install).toBe(1)
  setState("channel", "dev")
  await settle()
  expect(entry()).toBeNull()
})

test("687 completed old empty profile opens the default draft", async () => {
  setState({ existingInstall: true, pending: false })
  await mountOnboarding()
  expect(calls.opened).toEqual(["F:/synthetic/Default Project"])
  expect(calls.drafts).toEqual([{ server: "local", directory: "F:/synthetic/Default Project" }])
  expect(calls.selected).toEqual(["draft"])
  expect(calls.loaded).toBe(1)
})
test("687 existing projects and open tabs retain their state", async () => {
  setState({ existingInstall: true, pending: false, projects: [{ worktree: "F:/existing" }], tabs: ["existing-tab"] })
  await mountOnboarding()
  expect(calls.opened).toEqual([])
  expect(calls.drafts).toEqual([])
  expect(calls.selected).toEqual([])
  expect(calls.sidebar).toBe(0)
  expect(calls.restored).toBe(1)
  expect(calls.loaded).toBe(1)
})

for (const input of [
  { projects: [{ worktree: "F:/existing" }], tabs: [] },
  { projects: [], tabs: ["existing-tab"] },
])
  test("687 either existing projects or tabs prevent a replacement draft " + JSON.stringify(input), async () => {
    setState({ existingInstall: true, pending: false, ...input })
    await mountOnboarding()
    expect(calls.opened).toEqual([])
    expect(calls.drafts).toEqual([])
    expect(calls.selected).toEqual([])
    expect(calls.loaded).toBe(1)
  })
test("687 About has only third-party notices and preserves original MIT text", async () => {
  const { SettingsAbout } = await import("../../src/components/settings-v2/about")
  const host = document.createElement("main")
  document.body.append(host)
  disposals.push(
    render(
      () => (
        <I18nProvider value={language}>
          <SettingsAbout />
        </I18nProvider>
      ),
      host,
    ),
  )
  await settle()
  expect(document.body.textContent).toContain("© 2026 Zaovra")
  expect(button(language.t("settings.about.license"))).toBeUndefined()
  button(language.t("settings.about.notices")).click()
  await settle()
  expect(document.body.textContent).toContain("Copyright (c) 2025 opencode")
  expect(document.body.textContent).toContain("Permission is hereby granted")
})
