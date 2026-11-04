import { cp, lstat, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"

export function legacyBackend(input: {
  env: NodeJS.ProcessEnv
  home: string
  channel: string
  packaged: boolean
  userDataPath: string
  explicitProfile?: boolean
}) {
  const data = join(
    input.explicitProfile || (input.packaged && input.channel === "prod")
      ? join(input.userDataPath, "data")
      : input.env.XDG_DATA_HOME || join(input.home, ".local", "share"),
    "zaovra",
  )
  const filename = input.explicitProfile
    ? "zaovra.db"
    : input.env.ZAOVRA_DB ||
      (input.packaged && input.channel === "dev" && !["1", "true"].includes(input.env.ZAOVRA_DISABLE_CHANNEL_DB ?? "")
        ? "zaovra-dev.db"
        : "zaovra.db")
  return {
    data,
    database: filename === ":memory:" ? undefined : isAbsolute(filename) ? filename : join(data, filename),
    config: input.explicitProfile
      ? join(input.userDataPath, "config", "zaovra")
      : input.env.ZAOVRA_CONFIG_DIR || join(input.env.XDG_CONFIG_HOME || join(input.home, ".config"), "zaovra"),
  }
}

export async function prepareBackendUpgrade(input: {
  channel: string
  userDataPath: string
  legacy?: ReturnType<typeof legacyBackend>
  choose: () => Promise<"import" | "empty" | "cancel">
}) {
  const target = join(input.userDataPath, "backend")
  const completed = await readFile(join(target, "upgrade.json"), "utf8").then(
    (text) => JSON.parse(text) as { version: number; channel: string; action: string },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    },
  )
  if (completed) {
    if (completed.version !== 1 || completed.channel !== input.channel)
      throw new Error("Backend profile identity mismatch")
    return completed.action
  }
  // Never merge a partial or unrecognized destination with imported credentials.
  if (await exists(target)) throw new Error("Backend directory exists without a completed upgrade")
  const legacy = input.channel === "beta" ? undefined : input.legacy
  const available = legacy && ((await exists(legacy.database)) || (await exists(legacy.config)))
  const action = available ? (input.channel === "prod" ? "import" : await input.choose()) : "empty"
  if (action === "cancel") return action
  await mkdir(input.userDataPath, { recursive: true })
  const stage = await mkdtemp(join(input.userDataPath, ".backend-upgrade-"))
  // Node >=24.15 rejects an existing destination directory with errorOnExist.
  // Leave each leaf to cp; missing sources get an empty leaf instead.
  await mkdir(join(stage, "data"), { recursive: true, mode: 0o700 })
  await mkdir(join(stage, "config"), { recursive: true, mode: 0o700 })
  const importing = action === "import" ? legacy : undefined
  const skipped = await copyTree(importing?.data, join(stage, "data", "zaovra"), true, importing?.database)
  await copyTree(importing?.config, join(stage, "config", "zaovra"), false)
  if (importing?.database && (await exists(importing.database))) {
    const blocked =
      (await lstat(importing.database)).isSymbolicLink() ||
      skipped.some((path) => {
        const nested = relative(resolve(path), resolve(importing.database!))
        return !nested || (!nested.startsWith("..") && !isAbsolute(nested))
      })
    if (blocked) console.warn("[backend-upgrade] Skipped symbolic link database")
    if (!blocked) {
      const { DatabaseSync, backup } = await import("node:sqlite")
      const source = new DatabaseSync(importing.database, { readOnly: true, timeout: 5000 })
      try {
        // Online backup includes committed WAL pages even while the old app is open.
        await backup(source, join(stage, "data", "zaovra", "zaovra.db"))
      } finally {
        source.close()
      }
      const verification = new DatabaseSync(join(stage, "data", "zaovra", "zaovra.db"), { readOnly: true })
      try {
        if (Object.values(verification.prepare("PRAGMA quick_check").get() ?? {})[0] !== "ok")
          throw new Error("Imported database failed integrity validation")
      } finally {
        verification.close()
      }
    }
  }
  await writeFile(join(stage, "upgrade.json"), JSON.stringify({ version: 1, channel: input.channel, action }), {
    flag: "wx",
    mode: 0o600,
  })
  // Data, config and completion are published together. Failed stages remain
  // private and inactive; retry never consumes them or changes the source.
  await rename(stage, target)
  return action
}

async function exists(path?: string) {
  if (!path) return false
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
}

async function copyTree(source: string | undefined, target: string, data: boolean, database?: string) {
  const skipped: string[] = []
  if (!source || !(await exists(source))) {
    await mkdir(target, { recursive: true, mode: 0o700 })
    return skipped
  }
  const nested = relative(resolve(source), resolve(target))
  if (!nested || (!nested.startsWith("..") && !isAbsolute(nested)))
    throw new Error("Upgrade source contains destination")
  await cp(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (path) => {
      if ((await lstat(path)).isSymbolicLink()) {
        skipped.push(path)
        console.warn("[backend-upgrade] Skipped symbolic link")
        return false
      }
      // Only the selected database is imported, through SQLite's backup API.
      if (data && database && [database, database + "-wal", database + "-shm", database + "-journal"].includes(path))
        return false
      return !data || !/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/i.test(path)
    },
  })
  // A skipped source root still needs an empty private destination leaf.
  await mkdir(target, { recursive: true, mode: 0o700 })
  return skipped
}
