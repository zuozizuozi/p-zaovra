export * as Screenshot from "./screenshot"

import path from "node:path"
import fs from "node:fs/promises"

export const MAX_BYTES = 4 * 1024 * 1024
export const RETENTION_MS = 7 * 86400000

export function reference(file: string) {
  const id = path.basename(file)
  if (!/^tool_[a-f0-9]+_[a-zA-Z0-9_-]+\.png$/.test(id)) throw new Error("Invalid screenshot reference")
  return id
}

/** Only server-owned storage directories may be supplied; clients supply the ID alone. */
export async function read(directory: string, sessionID: string, id: string) {
  const prefix = `tool_${Buffer.from(sessionID).toString("hex")}_`
  if (!id.startsWith(prefix) || !/^tool_[a-f0-9]+_[a-zA-Z0-9_-]+\.png$/.test(id))
    throw new Error("Screenshot reference is not owned by this session")
  const file = path.join(directory, id)
  const entry = await fs.lstat(file)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Invalid screenshot source")
  const handle = await fs.open(file, "r")
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino)
      throw new Error("Screenshot source changed")
    if (stat.size > MAX_BYTES) throw new Error("Screenshot exceeds 4 MiB")
    if (Date.now() - stat.mtimeMs > RETENTION_MS) throw new Error("Screenshot expired")
    // Bound the read even if a producer or external process grows the file after stat.
    const data = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await handle.read(data, 0, data.length, 0)
    if (bytesRead !== stat.size) throw new Error("Screenshot source changed")
    const bytes = data.subarray(0, bytesRead)
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error("Invalid PNG screenshot")
    return bytes
  } finally {
    await handle.close()
  }
}
