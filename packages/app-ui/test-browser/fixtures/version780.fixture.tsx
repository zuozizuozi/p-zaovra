import { expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import type { UpdaterState } from "../../src/updater"

const zh = await import("../../src/i18n/zh")
const en = await import("../../src/i18n/en")
const [state, setState] = createStore({
  locale: "zh",
  version: "0.2.0-beta.1",
  update: { status: "idle" } as UpdaterState,
})
const language = {
  locale: () => state.locale,
  t: (key: string, values?: Record<string, string>) => {
    const dictionary: Record<string, string> = state.locale === "zh" ? zh.dict : en.dict
    return Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      dictionary[key] ?? key,
    )
  },
}
const toasts: Array<{ title: string; description?: string }> = []
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/highlights", () => ({ useHighlights: () => ({ available: () => false }) }))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    platform: "desktop",
    channel: "beta",
    get version() {
      return state.version
    },
    openLink() {},
    updater: { state: () => state.update },
  }),
}))
mock.module("@/utils/toast", () => ({
  showToast: (toast: { title: string; description?: string }) => {
    toasts.push(toast)
    return "version780"
  },
}))
const { SettingsAbout } = await import("../../src/components/settings-v2/about")
const { UpdaterNotification } = await import("../../src/components/updater-notification")

test("780 actual About and update notification render bilingual display versions and keep raw identity", async () => {
  const host = document.createElement("main")
  document.body.append(host)
  const dispose = render(
    () => (
      <I18nProvider value={language}>
        <SettingsAbout />
      </I18nProvider>
    ),
    host,
  )
  try {
    expect(host.textContent).toContain("Beta 0.2.0")
    expect(host.textContent).not.toContain("0.2.0-beta.1")
    setState("locale", "en")
    expect(host.textContent).toContain("Version Beta 0.2.0")
    expect(state.version).toBe("0.2.0-beta.1")
    const stop = createRoot((dispose) => {
      UpdaterNotification()
      return dispose
    })
    try {
      setState("update", { status: "available", version: "0.2.1-beta.1" })
      await new Promise((done) => setTimeout(done, 0))
      expect(toasts.at(-1)?.title).toContain("Beta 0.2.1")
      setState("locale", "zh")
      setState("update", { status: "ready", version: "0.2.1-beta.1" })
      await new Promise((done) => setTimeout(done, 0))
      expect(toasts.at(-1)?.description).toContain("Beta 0.2.1")
      expect(state.update).toEqual({ status: "ready", version: "0.2.1-beta.1" })
    } finally {
      stop()
    }
  } finally {
    dispose()
    host.remove()
  }
})
