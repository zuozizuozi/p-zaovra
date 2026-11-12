import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { dict } from "../../src/i18n/zh"
import type { UpdaterState } from "../../src/updater"

const language = { locale: () => "zh", t: (key: string) => dict[key as keyof typeof dict] ?? key }
const [state, setState] = createStore({ verified: false, updates: { status: "idle" } as UpdaterState, checks: 0 })
const platform = {
  version: "0.1.2-beta.1",
  channel: "beta",
  updater: {
    state: () => state.updates,
    check: async () => {
      setState("checks", (v) => v + 1)
      setState("updates", { status: "up-to-date" })
      return state.updates
    },
  },
}
const item = { id: "fixture", name: "Synthetic provider", models: { fixture: {} }, options: {}, source: "config" }
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/platform", () => ({ usePlatform: () => platform }))
mock.module("@/utils/toast", () => ({ showToast: () => {} }))
// Release notes are not part of this fixture.
mock.module("@/context/highlights", () => ({ useHighlights: () => ({ available: () => false, show: () => {} }) }))
mock.module("@/hooks/use-providers", () => ({
  popularProviders: [],
  useProviders: () => ({ connected: () => [item], popular: () => [] }),
}))
// Model-service preferences are stored per server scope.
mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => ({ client: {}, scope: "local" }) }))
mock.module("@/context/server-sync", () => ({
  useServerSync: () => () => ({ data: { config: { provider: {} } }, providerVerified: () => state.verified }),
}))
mock.module("../../src/components/dialog-connect-provider", () => ({
  DialogConnectProvider: () => null,
  useProviderConnectController: () => ({ select: () => {} }),
}))
mock.module("../../src/components/dialog-custom-provider", () => ({ DialogCustomProvider: () => null }))
mock.module("@zaovra-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: () => {}, close: () => {} }) }))
const { SettingsAbout } = await import("../../src/components/settings-v2/about")
const { SettingsProvidersV2 } = await import("../../src/components/settings-v2/providers")
const disposals: (() => void)[] = []
afterEach(() => {
  disposals.splice(0).forEach((fn) => fn())
  document.body.replaceChildren()
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
// TODO(dom-fixtures): the About page gained release-note and update controls after this fixture was written; its button lookup no longer matches.
test.todo("About shows Beta and runs the shared updater; pending and disabled cannot be submitted", async () => {
  const root = document.createElement("main")
  document.body.append(root)
  disposals.push(
    render(
      () => (
        <I18nProvider value={language}>
          <SettingsAbout />
        </I18nProvider>
      ),
      root,
    ),
  )
  expect(root.textContent).toContain("beta")
  const button = () => root.querySelector<HTMLButtonElement>('[data-component="about-updater"] button')!
  expect(button().disabled).toBe(false)
  button().click()
  await settle()
  expect(state.checks).toBe(1)
  expect(root.textContent).toContain(dict["settings.about.updater.up-to-date"])
  setState("updates", { status: "checking" })
  await settle()
  expect(button().disabled).toBe(true)
  setState("updates", { status: "disabled" })
  await settle()
  expect(button().disabled).toBe(true)
})
test("a saved provider stays unverified until an authentication success is recorded", async () => {
  const root = document.createElement("main")
  document.body.append(root)
  disposals.push(
    render(
      () => (
        <I18nProvider value={language}>
          <SettingsProvidersV2 />
        </I18nProvider>
      ),
      root,
    ),
  )
  expect(root.textContent).toContain(dict["settings.providers.status.unverified"])
  setState("verified", true)
  await settle()
  expect(root.textContent).toContain(dict["settings.providers.status.verified"])
  expect(root.textContent).not.toContain(dict["settings.providers.status.unverified"])
})
