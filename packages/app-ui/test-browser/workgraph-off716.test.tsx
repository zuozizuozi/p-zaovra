import { expect, test } from "bun:test"
import { render } from "solid-js/web"
import { Platform, PlatformProvider } from "../src/context/platform"
import { SettingsProvider, useSettings } from "../src/context/settings"

test("upgrade disables a saved WorkGraph opt-in and keeps other settings on reopen", async () => {
  const saved = { general: { workGraph: true, showCustomAgents: true }, keybinds: { "session.new": "ctrl+alt+n" } }
  localStorage.setItem("settings.v3", JSON.stringify(saved))
  const host = document.createElement("div")
  document.body.append(host)
  const observed: boolean[] = []
  const Probe = () => {
    const settings = useSettings()
    observed.push(settings.general.workGraph())
    return (
      <span>
        {String(settings.general.workGraph())}:{String(settings.general.showCustomAgents())}
      </span>
    )
  }
  const mount = () =>
    render(
      () => (
        <PlatformProvider value={{ platform: "web", version: "0.1.0", openLink() {}, restart: async () => {} }}>
          <SettingsProvider>
            <Probe />
          </SettingsProvider>
        </PlatformProvider>
      ),
      host,
    )
  const dispose = mount()
  try {
    const deadline = Date.now() + 1000
    while (JSON.parse(localStorage.getItem("settings.v3")!).general.workGraph && Date.now() < deadline)
      await Bun.sleep(1)
    expect(JSON.parse(localStorage.getItem("settings.v3")!).general.workGraph).toBe(false)
    expect(host.textContent).toBe("false:true")
    expect(observed).toEqual([false])
    expect(JSON.parse(localStorage.getItem("settings.v3")!).keybinds).toEqual(saved.keybinds)
  } finally {
    dispose()
  }
  const reopen = mount()
  try {
    expect(host.textContent).toBe("false:true")
    expect(observed).toEqual([false, false])
  } finally {
    reopen()
    host.remove()
    localStorage.removeItem("settings.v3")
  }
})

test("delayed desktop storage cannot show WorkGraph before or after hydration", async () => {
  const initial = Promise.withResolvers<string>()
  const stored = new Map<string, string>()
  stored.set("settings.v3", JSON.stringify({ general: { workGraph: true, showCustomAgents: true } }))
  const writes: string[] = []
  const disabled = Promise.withResolvers<void>()
  const platform: Platform = {
    platform: "desktop",
    version: "0.1.0",
    openLink() {},
    restart: async () => {},
    openDirectoryPickerDialog: async () => undefined,
    storage: () => ({
      getItem: async (key) => (key === "settings.v3" ? initial.promise : (stored.get(key) ?? null)),
      setItem: async (key, value) => {
        stored.set(key, value)
        writes.push(key)
        if (key === "settings.v3" && JSON.parse(value).general.workGraph === false) disabled.resolve()
      },
      removeItem: async (key) => {
        stored.delete(key)
      },
    }),
  }
  const host = document.createElement("div")
  document.body.append(host)
  const Probe = () => {
    const settings = useSettings()
    return (
      <span>
        {String(settings.general.workGraph())}:{String(settings.general.showCustomAgents())}
      </span>
    )
  }
  const dispose = render(
    () => (
      <PlatformProvider value={platform}>
        <SettingsProvider>
          <Probe />
        </SettingsProvider>
      </PlatformProvider>
    ),
    host,
  )
  try {
    expect(host.textContent?.split(":")[0]).toBe("false")
    initial.resolve(stored.get("settings.v3")!)
    await disabled.promise
    expect(JSON.parse(stored.get("settings.v3")!).general.workGraph).toBe(false)
    expect(host.textContent).toBe("false:true")
    expect(writes.filter((key) => key === "settings.v3").length).toBeGreaterThan(0)
  } finally {
    dispose()
    host.remove()
  }
})
