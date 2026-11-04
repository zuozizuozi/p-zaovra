import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, readFile, readdir, symlink } from "node:fs/promises"
import { join } from "node:path"
import { wslUpgradeProgram } from "./upgrade"
const base = process.env.ZAOVRA_BETA_TEST_DIR
if (!base) throw new Error("Isolated fixtures required")
const profile = "a".repeat(16)
async function fixture(channel = "dev") {
  await mkdir(base!, { recursive: true })
  const home = await mkdtemp(join(base!, "wsl-"))
  const root = join(home, ".local/share/zaovra-desktop", channel, profile)
  const data = join(home, ".local/share/zaovra")
  const config = join(home, ".config/zaovra")
  await mkdir(data, { recursive: true })
  await mkdir(config, { recursive: true })
  return { home, root, data, config }
}
async function run(home: string, channel = "dev", mode = "migrate", action = "import", shared = true) {
  const child = Bun.spawn(
    [process.env.PYTHON ?? "python3", "-c", wslUpgradeProgram, channel, profile, mode, String(shared), action],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" },
  )
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { out, err, code }
}
test("609 WSL copy snapshots committed WAL and retains old data, config and one completion", async () => {
  const f = await fixture()
  const database = new Database(join(f.data, "zaovra.db"))
  try {
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE messages(text); INSERT INTO messages VALUES ('committed WAL')")
    await Bun.write(join(f.config, "auth.json"), "synthetic credential placeholder")
    await Bun.write(join(f.data, "asset.txt"), "asset")
    const result = await run(f.home)
    expect(result.code, result.err).toBe(0)
    const imported = new Database(join(f.root, "backend/data/zaovra/zaovra.db"), { readonly: true })
    try {
      expect(imported.query("SELECT text FROM messages").get()).toEqual({ text: "committed WAL" })
    } finally {
      imported.close()
    }
    expect(await Bun.file(join(f.root, "backend/config/zaovra/auth.json")).text()).toBe(
      "synthetic credential placeholder",
    )
    expect(await Bun.file(join(f.data, "asset.txt")).text()).toBe("asset")
    database.exec("INSERT INTO messages VALUES ('later')")
    expect((await run(f.home)).code).toBe(0)
    expect((await readdir(f.root)).filter((x) => x.startsWith(".backend-upgrade-"))).toHaveLength(0)
    expect(JSON.parse(await readFile(join(f.root, "backend/upgrade.json"), "utf8"))).toMatchObject({
      action: "import",
      profile,
    })
  } finally {
    database.close()
  }
})
test("609 explicit WSL profile never imports shared home; Beta always starts empty", async () => {
  for (const channel of ["dev", "beta"]) {
    const f = await fixture(channel)
    await Bun.write(join(f.data, "zaovra.db"), "corrupt shared data must not be consumed")
    expect(JSON.parse((await run(f.home, channel, "probe", "empty", false)).out).available).toBe(false)
    const result = await run(f.home, channel, "migrate", "empty", false)
    expect(result.code, result.err).toBe(0)
    expect(await readdir(join(f.root, "backend/data/zaovra"))).toEqual([])
    expect(await Bun.file(join(f.data, "zaovra.db")).text()).toBe("corrupt shared data must not be consumed")
  }
})
test("609 private pre-upgrade WSL profile wins over shared data", async () => {
  const f = await fixture()
  await mkdir(join(f.root, "data/zaovra"), { recursive: true })
  await Bun.write(join(f.root, "data/zaovra/private.txt"), "private")
  await Bun.write(join(f.data, "shared.txt"), "shared")
  const r = await run(f.home)
  expect(r.code, r.err).toBe(0)
  expect(await readdir(join(f.root, "backend/data/zaovra"))).toEqual(["private.txt"])
})
test("609 partial targets and corrupt databases block startup, preserving failed stages", async () => {
  const f = await fixture()
  await Bun.write(join(f.data, "zaovra.db"), "corrupt")
  const r = await run(f.home)
  expect(r.code).not.toBe(0)
  expect(await Bun.file(join(f.root, "backend/upgrade.json")).exists()).toBe(false)
  expect((await readdir(f.root)).some((x) => x.startsWith(".backend-upgrade-"))).toBe(true)
  expect(await Bun.file(join(f.data, "zaovra.db")).text()).toBe("corrupt")
  await mkdir(join(f.root, "backend"))
  const again = await run(f.home)
  expect(again.code).not.toBe(0)
})
test("609 linked legacy trees are skipped, never followed", async () => {
  const f = await fixture()
  const external = join(f.home, "external")
  await mkdir(external)
  await Bun.write(join(external, "secret.txt"), "synthetic outside tree")
  await Bun.write(join(f.config, "config.json"), "{}")
  await symlink(external, join(f.data, "linked"), process.platform === "win32" ? "junction" : "dir")
  const r = await run(f.home)
  expect(r.code, r.err).toBe(0)
  expect(await readdir(join(f.root, "backend/data/zaovra"))).toEqual([])
  expect(await Bun.file(join(external, "secret.txt")).text()).toBe("synthetic outside tree")
})
