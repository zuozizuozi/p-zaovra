import { afterAll, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"

afterAll(() => GlobalRegistrator.unregister())
const noop = () => {}
const state = { fail: true, writes: 0 }
const toasts: { title: string; description?: string }[] = []
mock.module("../../src/utils/toast", () => ({
  showToast: (value: { title: string; description?: string }) => toasts.push(value),
}))
const [directory, setDirectory] = createSignal<string | undefined>("/project-a")
mock.module("@solidjs/router", () => ({
  useParams: () => ({
    get dir() {
      return directory() ? btoa(directory()!) : undefined
    },
  }),
}))
mock.module("../../src/context/language", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
    locales: ["en"],
    locale: () => "en",
    label: (key: string) => key,
    setLocale: noop,
  }),
}))
mock.module("../../src/context/platform", () => ({
  usePlatform: () => ({
    platform: "desktop",
    openLink: noop,
    getPinchZoomEnabled: async () => false,
    setPinchZoomEnabled: async () => {
      state.writes++
      if (state.fail) throw new Error("settings store unavailable")
    },
  }),
}))
mock.module("@zaovra-ai/ui/theme/context", () => ({
  useTheme: () => ({
    ids: () => [],
    loadThemes: noop,
    themeId: () => "default",
    colorScheme: () => "system",
    setTheme: noop,
    setColorScheme: noop,
  }),
}))
mock.module("@zaovra-ai/ui/context/dialog", () => ({ useDialog: () => ({}) }))
// Release notes are not part of this fixture.
mock.module("../../src/context/highlights", () => ({
  useHighlights: () => ({ available: () => false, show: () => {} }),
}))
mock.module("../../src/context/permission", () => ({
  usePermission: () => ({ isAutoAcceptingDirectory: () => false }),
}))
mock.module("../../src/components/updater-action", () => ({
  useUpdaterAction: () => ({ action: () => ({ label: "update", disabled: true }), run: noop }),
}))
const controls = Object.fromEntries(
  [
    "showNavigation",
    "font",
    "uiFont",
    "terminalFont",
    "releaseNotes",
    "followup",
    "mobileTitlebarPosition",
    "shellToolPartsExpanded",
    "editToolPartsExpanded",
    "showCustomAgents",
    "showFileTree",
    "showReasoningSummaries",
    "showSearch",
    "showStatus",
    "workGraph",
    "newLayoutDesigns",
    "layoutTransitionAvailable",
    "newInterfaceNoticeVisible",
    "agent",
    "permissions",
    "errors",
    "agentEnabled",
    "permissionsEnabled",
    "errorsEnabled",
  ].flatMap((key) => [
    [key, () => false],
    [`set${key[0].toUpperCase()}${key.slice(1)}`, noop],
  ]),
)
mock.module("../../src/context/settings", () => ({
  useSettings: () => ({ general: controls, notifications: controls, sounds: controls, appearance: controls }),
  monoDefault: "",
  monoFontFamily: noop,
  monoInput: noop,
  sansDefault: "",
  sansFontFamily: noop,
  sansInput: noop,
  terminalDefault: "",
  terminalFontFamily: noop,
  terminalInput: noop,
}))
const calls: string[] = []
const writes: string[] = []
const [config, setConfig] = createSignal({ shell: "" })
mock.module("../../src/context/server-sync", () => ({
  useServerSync: () => () => ({
    data: {
      get config() {
        return config()
      },
    },
    updateConfig: async (value: { shell: string }) => {
      writes.push(value.shell)
      setConfig(value)
    },
  }),
}))
mock.module("../../src/context/server-sdk", () => ({
  useServerSDK: () => () => ({
    scope: "offline",
    client: {
      global: { modelsNetwork: { get: async () => ({ data: {} }) } },
      pty: {
        shells: async (input: { directory: string }) => {
          calls.push(input.directory)
          return {
            data: [
              {
                path: `${input.directory}/pwsh`,
                name: "PowerShell",
                acceptable: true,
                effective: true,
                source: "project",
              },
            ],
          }
        },
      },
    },
  }),
}))

test.each([true, false])("pinch zoom save failure=%s rolls back and reports once", async (failure) => {
  state.fail = failure
  state.writes = 0
  toasts.length = 0
  const { SettingsGeneralV2 } = await import("../../src/components/settings-v2/general")
  const { I18nProvider } = await import("@zaovra-ai/ui/context/i18n")
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () =>
      createComponent(I18nProvider, {
        value: { t: (key: string) => key, locale: () => "en" },
        get children() {
          return createComponent(SettingsGeneralV2, { section: "appearance" })
        },
      }),
    host,
  )
  try {
    await Bun.sleep(20)
    const input = host.querySelector<HTMLInputElement>('[data-action="settings-pinch-zoom"] input')
    expect(!!input).toBe(true)
    expect(input!.checked).toBe(false)
    input!.click()
    for (let attempt = 0; attempt < 50 && state.writes === 0; attempt++) await Bun.sleep(10)
    await Bun.sleep(20)
    expect(state.writes).toBe(1)
    expect(input!.checked).toBe(!failure)
    expect(toasts).toEqual(
      failure ? [{ title: "settings.network.saveError", description: "Error: settings store unavailable" }] : [],
    )
  } finally {
    dispose()
    host.remove()
  }
})
