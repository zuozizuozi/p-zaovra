import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { legacyBackend, prepareBackendUpgrade } from "../src/main/backend-upgrade.ts"
import { createSidecarEnv } from "../src/main/sidecar-env.ts"

const root = process.env.ZAOVRA_UPGRADE_TEST_DIR
const parent = process.env.ZAOVRA_UPGRADE_PARENT_ROOT
if (!root || !parent) throw new Error("Explicit isolated fixture and parent source roots required")
assert.equal(
  spawnSync("git", ["-C", parent, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  "a23943862386040f1f8a2c2a3cdacf4f0dfa3451",
)
await mkdir(root, { recursive: true })
const candidate = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const fixture = fileURLToPath(new URL("./backend-upgrade-fixture.ts", import.meta.url))
const profile = (name: string) => join(root, name, "profile")
const inherited = (name: string): NodeJS.ProcessEnv => ({
  ...process.env,
  ZAOVRA_DB: undefined,
  ZAOVRA_CONFIG_DIR: undefined,
  ZAOVRA_CONFIG: undefined,
  ZAOVRA_CONFIG_CONTENT: undefined,
  ZAOVRA_DISABLE_CHANNEL_DB: undefined,
  ZAOVRA_TEST_HOME: join(root, name, "home"),
  HOME: join(root, name, "home"),
  USERPROFILE: join(root, name, "home"),
  XDG_DATA_HOME: join(root, name, "shared-data"),
  XDG_CONFIG_HOME: join(root, name, "shared-config"),
  XDG_CACHE_HOME: join(root, name, "shared-cache"),
  XDG_STATE_HOME: join(root, name, "shared-state"),
  TEMP: join(root, name, "temp"),
  TMP: join(root, name, "temp"),
  TMPDIR: join(root, name, "temp"),
})
const source = (name: string, channel = "dev", packaged = false) =>
  legacyBackend({ env: inherited(name), home: inherited(name).HOME!, channel, packaged, userDataPath: profile(name) })
function run(env: NodeJS.ProcessEnv, original: boolean, channel = "dev", write = false) {
  const result = spawnSync("bun", ["run", "--define", `ZAOVRA_CHANNEL:${JSON.stringify(channel)}`, fixture], {
    env: {
      ...env,
      ZAOVRA_UPGRADE_SOURCE: original ? parent : candidate,
      ZAOVRA_UPGRADE_WRITE: write ? "1" : "",
    },
    cwd: candidate,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim())
}
async function generate(name: string, channel = "dev", packaged = false) {
  const text = spawnSync("git", ["-C", parent!, "show", "a2394386:packages/desktop-app/src/main/sidecar-env.ts"], {
    encoding: "utf8",
  })
  assert.equal(text.status, 0)
  const module = join(root!, "parent-sidecar-env.ts")
  await writeFile(module, text.stdout)
  const old = await import(new URL("file:///" + module.replaceAll("\\", "/")).href)
  const env = old.createSidecarEnv({
    env: inherited(name),
    platform: process.platform,
    channel,
    packaged,
    userDataPath: profile(name),
  })
  await mkdir(inherited(name).HOME!, { recursive: true })
  return run(env, true, channel, true)
}
const env = (name: string, channel = "dev", location = profile(name)) =>
  createSidecarEnv({
    env: inherited(name),
    platform: process.platform,
    packaged: false,
    channel,
    userDataPath: location,
  })
const unchanged = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex")

test("parent a239 Dev session, credential, provider and files survive explicit import and restart without reimport", async () => {
  const before = await generate("import")
  assert.equal(before.sessions.length, 1)
  assert.equal(before.credentialCount, 1)
  const database = source("import").database!
  const hash = await unchanged(database)
  let prompts = 0
  const input = {
    channel: "dev",
    userDataPath: profile("import"),
    legacy: source("import"),
    choose: async () => {
      prompts++
      return "import" as const
    },
  }
  assert.equal(await prepareBackendUpgrade(input), "import")
  assert.deepEqual(run(env("import"), false), {
    ...before,
    database: join(profile("import"), "backend/data/zaovra/zaovra.db"),
  })
  assert.equal(
    await readFile(join(profile("import"), "backend/data/zaovra/synthetic-output.txt"), "utf8"),
    "parent output",
  )
  assert.equal(await unchanged(database), hash)
  assert.equal(await prepareBackendUpgrade(input), "import")
  assert.equal(prompts, 1)
  assert.deepEqual(run(env("import"), false).sessions, before.sessions)
})

test("empty choice is durable; restart never imports source credentials; Beta never asks or imports", async () => {
  await generate("empty")
  const db = source("empty").database!
  const hash = await unchanged(db)
  let prompts = 0
  const input = {
    channel: "dev",
    userDataPath: profile("empty"),
    legacy: source("empty"),
    choose: async () => {
      prompts++
      return "empty" as const
    },
  }
  await prepareBackendUpgrade(input)
  await prepareBackendUpgrade(input)
  assert.equal(prompts, 1)
  assert.equal(run(env("empty"), false).credentialCount, 0)
  assert.deepEqual(run(env("empty"), false).sessions, [])
  assert.equal(await unchanged(db), hash)
  const beta = join(root!, "beta", "profile")
  await prepareBackendUpgrade({
    ...input,
    channel: "beta",
    userDataPath: beta,
    choose: async () => {
      throw Error("Beta must not prompt")
    },
  })
  assert.equal(run(env("empty", "beta", beta), false, "beta").credentialCount, 0)
})

test("corrupt database fails without completion; repairing source allows retry; cancel writes no destination", async () => {
  await generate("retry")
  const legacy = source("retry")
  const checkpoint = new DatabaseSync(legacy.database!)
  checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  checkpoint.close()
  const original = await readFile(legacy.database!)
  await writeFile(legacy.database!, "synthetic corruption")
  const input = { channel: "dev", userDataPath: profile("retry"), legacy, choose: async () => "import" as const }
  await assert.rejects(prepareBackendUpgrade(input))
  await assert.rejects(stat(join(profile("retry"), "backend")), { code: "ENOENT" })
  assert.equal(await readFile(legacy.database!, "utf8"), "synthetic corruption")
  await writeFile(legacy.database!, original)
  await prepareBackendUpgrade(input)
  assert.equal(run(env("retry"), false).credentialCount, 1)
  const cancel = join(root!, "cancel", "profile")
  assert.equal(await prepareBackendUpgrade({ ...input, userDataPath: cancel, choose: async () => "cancel" }), "cancel")
  await assert.rejects(stat(join(cancel, "backend")), { code: "ENOENT" })
})

test("prod automatically copies its old database and shared provider config; three installed channels diverge", async () => {
  const before = await generate("prod", "prod", true)
  const legacy = source("prod", "prod", true)
  const hash = await unchanged(legacy.database!)
  const input = {
    channel: "prod",
    userDataPath: profile("prod"),
    legacy,
    choose: async () => {
      throw Error("Prod must preserve automatically")
    },
  }
  await prepareBackendUpgrade(input)
  const prod = run(env("prod", "prod"), false, "prod")
  assert.deepEqual(prod.sessions, before.sessions)
  assert.deepEqual(prod.provider, before.provider)
  assert.equal(prod.credentialCount, 1)
  assert.equal(await unchanged(legacy.database!), hash)
  await generate("prod", "dev", false)
  const devProfile = join(root!, "coexisting-dev")
  const betaProfile = join(root!, "coexisting-beta")
  await prepareBackendUpgrade({
    channel: "dev",
    userDataPath: devProfile,
    legacy: source("prod"),
    choose: async () => "import",
  })
  await prepareBackendUpgrade({
    channel: "beta",
    userDataPath: betaProfile,
    legacy: source("prod"),
    choose: async () => {
      throw Error("No Beta import")
    },
  })
  const db = new DatabaseSync(prod.database)
  db.exec("UPDATE session SET title='prod only'")
  db.close()
  assert.equal(run(env("prod", "dev", devProfile), false).sessions[0].title, "parent session")
  assert.equal(run(env("prod", "beta", betaProfile), false, "beta").credentialCount, 0)
  await prepareBackendUpgrade(input)
  assert.equal(run(env("prod", "prod"), false, "prod").sessions[0].title, "prod only")
})

test("packaged Dev imports the parent's dev-named database into its isolated current database", async () => {
  await generate("packaged-dev", "dev", true)
  await prepareBackendUpgrade({
    channel: "dev",
    userDataPath: profile("packaged-dev"),
    legacy: source("packaged-dev", "dev", true),
    choose: async () => "import",
  })
  const result = run(env("packaged-dev"), false)
  assert.equal(result.credentialCount, 1)
  assert.equal(result.sessions[0].title, "parent session")
})

test("online import includes committed WAL and excludes later writes without copying WAL files", async () => {
  const directory = join(root!, "wal-source")
  await mkdir(directory, { recursive: true })
  const database = join(directory, "zaovra.db")
  const writer = new DatabaseSync(database)
  writer.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('committed WAL')",
  )
  try {
    assert.ok((await stat(database + "-wal")).size > 0)
    const location = join(root!, "wal", "profile")
    await prepareBackendUpgrade({
      channel: "dev",
      userDataPath: location,
      legacy: { data: directory, database, config: join(directory, "absent") },
      choose: async () => "import",
    })
    const copy = new DatabaseSync(join(location, "backend/data/zaovra/zaovra.db"), { readOnly: true })
    try {
      assert.equal(copy.prepare("SELECT value FROM evidence").get()?.value, "committed WAL")
      writer.exec("INSERT INTO evidence VALUES ('later')")
      assert.equal(copy.prepare("SELECT count(*) AS count FROM evidence").get()?.count, 1)
      assert.equal(writer.prepare("SELECT count(*) AS count FROM evidence").get()?.count, 2)
    } finally {
      copy.close()
    }
  } finally {
    writer.close()
  }
})

test("packaged Dev legacy channel filename and explicit DB paths are resolved for import only", () => {
  assert.equal(
    source("packaged", "dev", true).database,
    join(inherited("packaged").XDG_DATA_HOME!, "zaovra/zaovra-dev.db"),
  )
  assert.equal(
    legacyBackend({
      env: { ZAOVRA_DB: "custom.db" },
      home: root!,
      channel: "dev",
      packaged: false,
      userDataPath: profile("custom"),
    }).database,
    join(root!, ".local/share/zaovra/custom.db"),
  )
  assert.equal(env("custom").ZAOVRA_DB, undefined)
})
