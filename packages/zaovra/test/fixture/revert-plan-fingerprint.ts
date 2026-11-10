import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export async function fingerprint(roots: readonly string[], runtimeLog?: string) {
  const files: string[] = []
  const readonlyFiles: string[] = []
  const entries: {
    root: string
    path: string
    kind: "file" | "link"
    sha256: string
    bytes: number
    birthtimeMs: number
    mtimeMs: number
    ctimeMs: number
    runtimeLog: boolean
  }[] = []
  const visit = async (directory: string, root: string) => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(filename, root)
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      const bytes = entry.isFile() ? await fs.readFile(filename) : Buffer.from(await fs.readlink(filename))
      const sha256 = createHash("sha256").update(bytes).digest("hex")
      const stat = await fs.lstat(filename)
      const value = filename + (entry.isFile() ? ":" + sha256 : ":link:" + bytes.toString())
      files.push(value)
      // Only the caller's exact runtime log is outside the read-only data assertion.
      if (filename !== runtimeLog) readonlyFiles.push(value)
      entries.push({
        root,
        path: path.relative(root, filename).split(path.sep).join("/"),
        kind: entry.isFile() ? "file" : "link",
        sha256,
        bytes: bytes.length,
        birthtimeMs: stat.birthtimeMs,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        runtimeLog: filename === runtimeLog,
      })
    }
  }
  for (const root of roots) await visit(root, root)
  return {
    hash: createHash("sha256").update(JSON.stringify(readonlyFiles)).digest("hex"),
    combinedHash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files: entries,
  }
}
