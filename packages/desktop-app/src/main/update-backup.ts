import { mkdir, rename, stat, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join } from "node:path"

export function updateDatabasePath(env: NodeJS.ProcessEnv, home: string) {
  if (env.ZAOVRA_DB === ":memory:") return undefined
  const root = join(
    env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, ".local", "share"),
    "zaovra",
  )
  return env.ZAOVRA_DB && isAbsolute(env.ZAOVRA_DB) ? env.ZAOVRA_DB : join(root, env.ZAOVRA_DB || "zaovra.db")
}

export async function backupUpdateDatabase(input: { source?: string; directory: string; version: string }) {
  if (!input.source) return { backedUp: false, reason: "memory_database" }
  const exists = await stat(input.source).then(
    (value) => value.isFile(),
    (error) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
  if (!exists) return { backedUp: false, reason: "database_not_created" }
  const { DatabaseSync, backup } = await import("node:sqlite")
  const directory = join(input.directory, Date.now() + "-" + crypto.randomUUID())
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const partial = join(directory, basename(input.source) + ".partial")
  const target = join(directory, basename(input.source))
  const source = new DatabaseSync(input.source, { readOnly: true, timeout: 5000 })
  try {
    // SQLite online backup includes committed WAL pages without stopping the server.
    await backup(source, partial)
  } finally {
    source.close()
  }
  const verification = new DatabaseSync(partial, { readOnly: true })
  try {
    if (Object.values(verification.prepare("PRAGMA quick_check").get() ?? {})[0] !== "ok")
      throw new Error("Update backup failed integrity validation")
  } finally {
    verification.close()
  }
  await rename(partial, target)
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify(
      {
        created: new Date().toISOString(),
        version: input.version,
        source: input.source,
        backup: target,
        method: "sqlite_online_backup",
        integrity: "ok",
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  )
  return { backedUp: true, directory }
}
