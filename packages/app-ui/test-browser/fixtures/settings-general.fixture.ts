import { afterAll, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"

afterAll(() => GlobalRegistrator.unregister())
const noop = () => {}
const legacy = process.env.O5_LEGACY === "1"
const [directory, setDirectory] = createSignal<string | undefined>("/project-a")
mock.module("@solidjs/router", () => ({ useParams: () => ({ get dir() { return directory() ? btoa(directory()!) : undefined } }) }))
mock.module("../../src/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key, locales: ["en"], locale: () => "en", label: (key: string) => key, setLocale: noop }) }))
mock.module("../../src/context/platform", () => ({ usePlatform: () => ({ platform: "web", openLink: noop }) }))
mock.module("@zaovra-ai/ui/theme/context", () => ({ useTheme: () => ({ ids: () => [], loadThemes: noop, themeId: () => "default", colorScheme: () => "system", setTheme: noop, setColorScheme: noop }) }))
mock.module("@zaovra-ai/ui/context/dialog", () => ({ useDialog: () => ({}) }))
mock.module("../../src/context/permission", () => ({ usePermission: () => ({ isAutoAcceptingDirectory: () => false }) }))
mock.module("../../src/components/updater-action", () => ({ useUpdaterAction: () => ({ action: () => ({ label: "update", disabled: true }), run: noop }) }))
const controls = Object.fromEntries([
  "showNavigation", "font", "uiFont", "terminalFont", "releaseNotes", "followup", "mobileTitlebarPosition", "shellToolPartsExpanded", "editToolPartsExpanded", "showCustomAgents", "showFileTree", "showReasoningSummaries", "showSearch", "showStatus", "workGraph", "newLayoutDesigns", "layoutTransitionAvailable", "newInterfaceNoticeVisible", "agent", "permissions", "errors", "agentEnabled", "permissionsEnabled", "errorsEnabled",
].flatMap((key) => [[key, () => false], [`set${key[0].toUpperCase()}${key.slice(1)}`, noop]]))
mock.module("../../src/context/settings", () => ({ useSettings: () => ({ general: controls, notifications: controls, sounds: controls, appearance: controls }), monoDefault: "", monoFontFamily: noop, monoInput: noop, sansDefault: "", sansFontFamily: noop, sansInput: noop, terminalDefault: "", terminalFontFamily: noop, terminalInput: noop }))
const calls: string[] = []
const writes: string[] = []
const [config, setConfig] = createSignal({ shell: "" })
mock.module("../../src/context/server-sync", () => ({ useServerSync: () => () => ({ data: { get config() { return config() } }, updateConfig: async (value: { shell: string }) => { writes.push(value.shell); setConfig(value) } }) }))
mock.module("../../src/context/server-sdk", () => ({ useServerSDK: () => () => ({ scope: "offline", client: { global: { modelsNetwork: { get: async () => ({ data: {} }) } }, pty: { shells: async (input: { directory: string }) => { calls.push(input.directory); return { data: [{ path: `${input.directory}/pwsh`, name: "PowerShell", acceptable: true, effective: true, source: "project" }] } } } } }) }))

test("actual general page refreshes project shell and clears it without a directory", async () => {
  const { SettingsGeneralV2 } = await import("../../src/components/settings-v2/general")
  const { SettingsGeneral } = await import("../../src/components/settings-general")
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => legacy ? createComponent(SettingsGeneral, {}) : createComponent(SettingsGeneralV2, { section: "general", get directory() { return directory() } }), host)
  try {
    await Bun.sleep(20)
    expect(host.querySelector('[data-action="settings-shell"]')).not.toBeNull()
    expect(host.textContent).toContain("/project-a/pwsh")
    const trigger = legacy ? host.querySelector('[data-action="settings-shell"] button') : host.querySelector('[data-action="settings-shell"] [data-component="select-v2"]') ?? host.querySelector('[data-action="settings-shell"][data-component="select-v2"]')
    expect(trigger).not.toBeNull()
    trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await Bun.sleep(20)
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((node) => node.textContent?.includes("PowerShell"))
    expect(option).toBeDefined()
    option!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await Bun.sleep(20)
    expect(writes).toEqual(["/project-a/pwsh"])
    trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await Bun.sleep(20)
    const same = Array.from(document.querySelectorAll('[role="option"]')).find((node) => node.textContent?.includes("PowerShell"))
    same!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await Bun.sleep(20)
    expect(writes).toEqual(["/project-a/pwsh"])
    trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await Bun.sleep(20)
    const automatic = Array.from(document.querySelectorAll('[role="option"]')).find((node) => node.textContent?.includes("settings.general.row.shell.autoDefault"))
    expect(automatic).toBeDefined()
    automatic!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await Bun.sleep(20)
    expect(writes).toEqual(["/project-a/pwsh", ""])
    setDirectory("/project-b")
    await Bun.sleep(20)
    expect(host.textContent).toContain("/project-b/pwsh")
    expect(host.textContent).not.toContain("/project-a/pwsh")
    setDirectory(undefined)
    await Bun.sleep(20)
    expect(host.textContent).toContain("settings.shell.globalOnly")
    expect(host.textContent).not.toContain("/project-b/pwsh")
    expect(calls).toEqual(["/project-a", "/project-a", "/project-a", "/project-b"])
  } finally { dispose(); host.remove() }
})






