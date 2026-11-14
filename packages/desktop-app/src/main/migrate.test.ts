import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = mkdtempSync(join(tmpdir(), "tauri-migration-"))
const stores = new Map<string, Map<string, unknown>>()
const profile = { explicit: false }
const appdata = process.env.APPDATA
const xdg = process.env.XDG_DATA_HOME
process.env.APPDATA = root
process.env.XDG_DATA_HOME = root
mock.module("node:os", () => ({ homedir: () => root, tmpdir }))
mock.module("electron", () => ({ app: { isPackaged: false, commandLine: { hasSwitch: () => profile.explicit } } }))
mock.module("electron-log/main.js", () => ({ default: { log() {}, warn() {} } }))
mock.module("./constants", () => ({ CHANNEL: "dev" }))
mock.module("./store", () => ({
  getStore(name = "settings") {
    const store = stores.get(name) ?? new Map<string, unknown>()
    stores.set(name, store)
    return store
  },
}))
const { migrate } = await import("./migrate")
const directory = join(
  root,
  ...(process.platform === "darwin" ? ["Library", "Application Support"] : []),
  "ai.zaovra.desktop.dev",
)

beforeEach(() => {
  stores.clear()
  profile.explicit = false
  rmSync(directory, { recursive: true, force: true })
})
afterAll(() => {
  if (appdata === undefined) delete process.env.APPDATA
  else process.env.APPDATA = appdata
  if (xdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = xdg
  rmSync(root, { recursive: true, force: true })
})

test.each(["parse", "read"])("a %s failure remains retryable and successful files keep user values", (failure) => {
  mkdirSync(directory, { recursive: true })
  const broken = join(directory, "bad.dat")
  if (failure === "parse") writeFileSync(broken, "{broken")
  if (failure === "read") mkdirSync(broken)
  writeFileSync(join(directory, "good.dat"), '{"theme":"dark"}')
  migrate()
  expect(stores.get("settings")?.get("tauriMigrated")).not.toBe(true)
  expect(stores.get("good.dat")?.get("theme")).toBe("dark")
  stores.get("good.dat")!.set("theme", "user-choice")
  rmSync(broken, { recursive: true, force: true })
  writeFileSync(broken, '{"font":"mono"}')
  migrate()
  expect(stores.get("settings")?.get("tauriMigrated")).toBe(true)
  expect(stores.get("bad.dat")?.get("font")).toBe("mono")
  expect(stores.get("good.dat")?.get("theme")).toBe("user-choice")
})

test("missing source is complete and explicit profiles never import", () => {
  migrate()
  expect(stores.get("settings")?.get("tauriMigrated")).toBe(true)
  stores.clear()
  profile.explicit = true
  migrate()
  expect(stores.size).toBe(0)
})
