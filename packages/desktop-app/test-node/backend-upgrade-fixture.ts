import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { Database as SQLite } from "bun:sqlite"
import { Effect } from "effect"

const root = process.env.ZAOVRA_UPGRADE_SOURCE
if (!root) throw new Error("Explicit parent/candidate source root required")
const { Credential } = await import(pathToFileURL(join(root, "packages/core/src/credential.ts")).href)
const { Database } = await import(pathToFileURL(join(root, "packages/core/src/database/database.ts")).href)
const { Global } = await import(pathToFileURL(join(root, "packages/core/src/global.ts")).href)
const { LayerNode } = await import(pathToFileURL(join(root, "packages/core/src/effect/layer-node.ts")).href)
const credentials = await Effect.runPromise(
  Effect.gen(function* () {
    const service = yield* Credential.Service
    if (process.env.ZAOVRA_UPGRADE_WRITE)
      yield* service.create({
        integrationID: "upgrade-fixture",
        value: Credential.Key.make({ type: "key", key: "synthetic-upgrade-591" }),
      })
    return yield* service.all()
  }).pipe(Effect.provide(LayerNode.compile(Credential.node))),
)
const db = new SQLite(Database.path())
if (process.env.ZAOVRA_UPGRADE_WRITE) {
  // Use the parent's real migration schema, not a parallel fixture database.
  db.run(
    "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('upgrade-project',?,1,1,'[]')",
    [Global.Path.home],
  )
  db.run(
    "INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES ('ses_upgrade','upgrade-project','upgrade',?,'parent session','a2394386',1,1)",
    [Global.Path.home],
  )
  await mkdir(Global.Path.config, { recursive: true })
  await writeFile(
    join(Global.Path.config, "zaovra.json"),
    JSON.stringify({ provider: { "upgrade-fixture": { name: "Parent synthetic provider", models: {} } } }),
  )
  await writeFile(join(Global.Path.data, "synthetic-output.txt"), "parent output")
}
const sessions = db.query("SELECT id,title FROM session").all()
db.close()
const provider = await readFile(join(Global.Path.config, "zaovra.json"), "utf8").then(
  (text) => JSON.parse(text),
  () => null,
)
console.log(JSON.stringify({ sessions, credentialCount: credentials.length, provider, database: Database.path() }))
