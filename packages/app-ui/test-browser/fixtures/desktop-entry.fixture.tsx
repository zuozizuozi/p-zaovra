import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { dict } from "../../../desktop-app/src/renderer/i18n/zh"
import { dict as appDict } from "../../src/i18n/zh"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
const calls = {
  connect: 0,
  picker: 0,
  opened: [] as string[],
  finished: [] as boolean[],
  check: 0,
  download: 0,
  install: 0,
}
const [state, setState] = createStore({
  connected: false,
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
  useSettings: () => ({ general: { setOldLayoutEligible: () => {} } }),
  useServer: () => ({
    ready: { promise: Promise.resolve() },
    isLocal: () => true,
    list: [],
    key: "local",
    projects: { open: (path: string) => calls.opened.push(path), touch: () => {} },
  }),
  useTabs: () => ({
    ready: { promise: Promise.resolve() },
    recentReady: { promise: Promise.resolve() },
    store: [],
    newDraft: async () => "draft",
    select: () => {},
  }),
  useProviders: () => ({ loading: () => false, connected: () => (state.connected ? [{ id: "fixture" }] : []) }),
  useSettingsDialog: () => () => {
    calls.connect++
  },
}))
const disposals: Array<() => void> = []
afterEach(() => {
  disposals.splice(0).forEach((d) => d())
  document.body.replaceChildren()
  setState({ connected: false, channel: "beta", update: { status: "idle" } })
})
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!
const settle = () => new Promise((r) => setTimeout(r, 30))
test("612 fresh desktop starts with model service then project choice, no error or fabricated model", async () => {
  Object.assign(window, {
    api: {
      isOldLayoutEligible: async () => false,
      isFirstLaunchOnboardingPending: async () => true,
      finishFirstLaunchOnboarding: async (create: boolean) => {
        calls.finished.push(create)
        return create ? { needsDirectory: true } : null
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
  disposals.push(render(() => <DesktopFirstLaunchOnboarding initialUrl="/" onLoaded={() => {}} />, host))
  await settle()
  expect(document.body.textContent).toContain("先连接模型服务")
  expect(document.body.textContent).not.toContain("不可用")
  expect(document.body.textContent).not.toContain("Default Project")
  expect(document.body.textContent).not.toContain("gpt-6-luna")
  expect(calls.opened).toEqual([])
  expect(calls.picker).toBe(0)
  button("1. 连接模型服务").click()
  expect(calls.connect).toBe(1)
  expect(button("选择文件夹").disabled).toBe(true)
  setState("connected", true)
  await settle()
  expect(button("选择文件夹").disabled).toBe(false)
  button("选择文件夹").click()
  await settle()
  expect(calls.opened).toEqual(["F:/synthetic-project"])
  expect(calls.finished).toEqual([true, false])
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
