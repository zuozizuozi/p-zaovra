import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { EventEmitter } from "node:events"
import { backupUpdateDatabase, updateDatabasePath } from "../src/main/update-backup.ts"
import { installUpdate } from "../src/main/updater-install.ts"

const root = process.env.ZAOVRA_BACKUP_TEST_DIR
if (!root) throw new Error("ZAOVRA_BACKUP_TEST_DIR must name the isolated test directory")
await mkdir(root, { recursive: true })

test("online update backup captures committed WAL while the writer remains open", async () => {
  const source = join(root, "wal-" + crypto.randomUUID() + ".db")
  const writer = new DatabaseSync(source)
  writer.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('committed WAL')",
  )
  assert.ok((await stat(source + "-wal")).size > 0)
  const result = await backupUpdateDatabase({ source, directory: join(root, "backups"), version: "0.1.0-beta.1" })
  assert.equal(result.backedUp, true)
  assert.ok(result.directory)
  const manifest = JSON.parse(await readFile(join(result.directory, "manifest.json"), "utf8"))
  const snapshot = new DatabaseSync(manifest.backup, { readOnly: true })
  try {
    assert.equal(snapshot.prepare("SELECT value FROM evidence").get()?.value, "committed WAL")
    writer.exec("INSERT INTO evidence VALUES ('later')")
    assert.equal(snapshot.prepare("SELECT count(*) AS count FROM evidence").get()?.count, 1)
    assert.equal(writer.prepare("SELECT count(*) AS count FROM evidence").get()?.count, 2)
    assert.equal(manifest.method, "sqlite_online_backup")
    assert.equal(manifest.integrity, "ok")
  } finally {
    snapshot.close()
    writer.close()
  }
})

test("a failed real database backup prevents quitting and installer dispatch", async () => {
  const source = join(root, "corrupt-" + crypto.randomUUID() + ".db")
  await writeFile(source, "not a sqlite database")
  const lifecycle = new EventEmitter()
  const states: boolean[] = []
  let dispatches = 0
  const updater = Object.assign(new EventEmitter(), {
    quitAndInstall() {
      dispatches += 1
    },
  })
  await assert.rejects(
    installUpdate({
      updater,
      lifecycle,
      quitting: (value) => states.push(value),
      beforeInstall: () => backupUpdateDatabase({ source, directory: join(root, "backups"), version: "0.1.0-beta.2" }),
    }),
  )
  assert.equal(dispatches, 0)
  assert.deepEqual(states, [])
  assert.equal(updater.listenerCount("error"), 0)
  assert.equal(lifecycle.listenerCount("before-quit-for-update"), 0)
})

test("database path honors custom and XDG paths; absent and memory databases need no backup", async () => {
  assert.equal(updateDatabasePath({ ZAOVRA_DB: ":memory:" }, root), undefined)
  assert.equal(updateDatabasePath({ ZAOVRA_DB: join(root, "custom.db") }, root), join(root, "custom.db"))
  assert.equal(
    updateDatabasePath({ XDG_DATA_HOME: root, ZAOVRA_DB: "relative.db" }, root),
    join(root, "zaovra", "relative.db"),
  )
  assert.deepEqual(await backupUpdateDatabase({ directory: root, version: "v" }), {
    backedUp: false,
    reason: "memory_database",
  })
  assert.deepEqual(await backupUpdateDatabase({ source: join(root, "missing.db"), directory: root, version: "v" }), {
    backedUp: false,
    reason: "database_not_created",
  })
})
