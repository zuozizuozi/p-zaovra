import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { legacyBackend, prepareBackendUpgrade } from "../src/main/backend-upgrade.ts"

const root = process.env.ZAOVRA_UPGRADE_TEST_DIR
if (!root) throw new Error("Explicit isolated fixture root required")
const version = process.versions.node.split(".").map(Number)
assert.ok(version[0] > 24 || (version[0] === 24 && version[1] >= 15), "Node >=24.15 required")
const profile = (name: string) => join(root, name, "profile")
const targetDatabase = (name: string) => join(profile(name), "backend/data/zaovra/zaovra.db")
const absent = (path: string) => assert.rejects(stat(path), { code: "ENOENT" })

async function seed(name: string, data: boolean, config: boolean, external = false) {
  const old = {
    data: join(root!, name, "old-data"),
    config: join(root!, name, "old-config"),
    database: join(root!, name, external ? "outside/selected.db" : "old-data/zaovra.db"),
  }
  if (data) {
    await mkdir(dirname(old.database), { recursive: true })
    const db = new DatabaseSync(old.database)
    db.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('legacy')")
    db.close()
    if (!external) await writeFile(join(old.data, "result.txt"), "retained result")
  }
  if (config) {
    await mkdir(old.config, { recursive: true })
    await writeFile(join(old.config, "provider.json"), '{"provider":"synthetic"}')
  }
  return old
}

for (const channel of ["prod", "dev"]) {
  for (const shape of ["data-config", "config-only", "data-only"]) {
    test(channel + " imports " + shape + " on the Electron Node filesystem implementation", async () => {
      const name = channel + "-" + shape
      const data = shape !== "config-only"
      const config = shape !== "data-only"
      const legacy = await seed(name, data, config)
      const before = data ? await readFile(legacy.database) : undefined
      let prompts = 0
      const input = {
        channel,
        userDataPath: profile(name),
        legacy,
        choose: async () => {
          prompts++
          return "import" as const
        },
      }
      assert.equal(await prepareBackendUpgrade(input), "import")
      assert.equal(prompts, channel === "dev" ? 1 : 0)
      if (data) {
        const db = new DatabaseSync(targetDatabase(name), { readOnly: true })
        assert.equal(db.prepare("SELECT value FROM evidence").get()?.value, "legacy")
        assert.equal(Object.values(db.prepare("PRAGMA quick_check").get()!)[0], "ok")
        db.close()
        assert.deepEqual(await readFile(legacy.database), before)
        assert.equal(await readFile(join(profile(name), "backend/data/zaovra/result.txt"), "utf8"), "retained result")
      }
      if (!data) await absent(targetDatabase(name))
      if (config)
        assert.equal(
          await readFile(join(profile(name), "backend/config/zaovra/provider.json"), "utf8"),
          '{"provider":"synthetic"}',
        )
      if (!config) await absent(join(profile(name), "backend/config/zaovra/provider.json"))
      assert.deepEqual(JSON.parse(await readFile(join(profile(name), "backend/upgrade.json"), "utf8")), {
        version: 1,
        channel,
        action: "import",
      })
      assert.equal(await prepareBackendUpgrade(input), "import")
      assert.equal(prompts, channel === "dev" ? 1 : 0)
    })
  }
}

test("external selected database imports even when its old data directory is absent", async () => {
  const name = "external"
  const legacy = await seed(name, true, true, true)
  const before = await readFile(legacy.database)
  await prepareBackendUpgrade({
    channel: "prod",
    userDataPath: profile(name),
    legacy,
    choose: async () => {
      throw Error("No prod prompt")
    },
  })
  const db = new DatabaseSync(targetDatabase(name), { readOnly: true })
  assert.equal(db.prepare("SELECT value FROM evidence").get()?.value, "legacy")
  db.close()
  assert.deepEqual(await readFile(legacy.database), before)
})

for (const existing of [false, true]) {
  test(
    "explicit prod profile " +
      (existing ? "retains its own old backend only" : "starts empty without importing shared home or overrides"),
    async () => {
      const name = existing ? "explicit-existing" : "explicit-new"
      const shared = await seed(name + "-shared", true, true, true)
      const location = profile(name)
      const ownData = join(location, "data/zaovra")
      const ownConfig = join(location, "config/zaovra")
      if (existing) {
        await mkdir(ownData, { recursive: true })
        const db = new DatabaseSync(join(ownData, "zaovra.db"))
        db.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('private')")
        db.close()
        await mkdir(ownConfig, { recursive: true })
        await writeFile(join(ownConfig, "provider.json"), '{"provider":"private"}')
      }
      const legacy = legacyBackend({
        channel: "prod",
        packaged: true,
        userDataPath: location,
        explicitProfile: true,
        home: join(root!, name, "shared-home"),
        env: {
          XDG_DATA_HOME: join(shared.data, ".."),
          XDG_CONFIG_HOME: join(shared.config, ".."),
          ZAOVRA_DB: shared.database,
          ZAOVRA_CONFIG_DIR: shared.config,
        },
      })
      assert.equal(legacy.data, ownData)
      assert.equal(legacy.database, join(ownData, "zaovra.db"))
      assert.equal(legacy.config, ownConfig)
      const before = await readFile(shared.database)
      const action = await prepareBackendUpgrade({
        channel: "prod",
        userDataPath: location,
        legacy,
        choose: async () => {
          throw Error("No explicit prod prompt")
        },
      })
      assert.equal(action, existing ? "import" : "empty")
      if (existing) {
        const db = new DatabaseSync(targetDatabase(name), { readOnly: true })
        assert.equal(db.prepare("SELECT value FROM evidence").get()?.value, "private")
        db.close()
        assert.equal(
          await readFile(join(location, "backend/config/zaovra/provider.json"), "utf8"),
          '{"provider":"private"}',
        )
        assert.ok((await stat(join(ownData, "zaovra.db"))).isFile())
      }
      if (!existing) await absent(targetDatabase(name))
      assert.deepEqual(await readFile(shared.database), before)
      assert.equal(
        await prepareBackendUpgrade({
          channel: "prod",
          userDataPath: location,
          legacy,
          choose: async () => {
            throw Error("No repeat")
          },
        }),
        action,
      )
    },
  )
}

test("existing unrecognized target is never merged or marked complete", async () => {
  const name = "existing-target"
  const legacy = await seed(name, true, true)
  await mkdir(join(profile(name), "backend"), { recursive: true })
  await writeFile(join(profile(name), "backend/keep.txt"), "owner")
  await assert.rejects(
    prepareBackendUpgrade({ channel: "prod", userDataPath: profile(name), legacy, choose: async () => "import" }),
    /exists without a completed upgrade/,
  )
  assert.equal(await readFile(join(profile(name), "backend/keep.txt"), "utf8"), "owner")
  await absent(join(profile(name), "backend/upgrade.json"))
})

test("source directory links are skipped while ordinary data and config complete", async () => {
  const name = "links"
  const legacy = await seed(name, true, true)
  const outside = join(root!, name, "outside")
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, "must-not-copy.txt"), "outside")
  await symlink(outside, join(legacy.data, "linked-data"), process.platform === "win32" ? "junction" : "dir")
  await symlink(outside, join(legacy.config, "linked-config"), process.platform === "win32" ? "junction" : "dir")
  await prepareBackendUpgrade({ channel: "prod", userDataPath: profile(name), legacy, choose: async () => "import" })
  await absent(join(profile(name), "backend/data/zaovra/linked-data"))
  await absent(join(profile(name), "backend/config/zaovra/linked-config"))
  assert.equal(await readFile(join(outside, "must-not-copy.txt"), "utf8"), "outside")
  assert.equal(
    await readFile(join(profile(name), "backend/config/zaovra/provider.json"), "utf8"),
    '{"provider":"synthetic"}',
  )
})

test("a linked source root cannot make SQLite backup follow the skipped directory", async () => {
  const name = "linked-root"
  const real = await seed(name, true, true)
  const linked = join(root!, name, "linked-data")
  await symlink(real.data, linked, process.platform === "win32" ? "junction" : "dir")
  await prepareBackendUpgrade({
    channel: "prod",
    userDataPath: profile(name),
    legacy: { ...real, data: linked, database: join(linked, "zaovra.db") },
    choose: async () => "import",
  })
  await absent(targetDatabase(name))
  assert.equal(
    await readFile(join(profile(name), "backend/config/zaovra/provider.json"), "utf8"),
    '{"provider":"synthetic"}',
  )
})
