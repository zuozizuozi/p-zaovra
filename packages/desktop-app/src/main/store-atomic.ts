import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"

// Keep the old file intact until the complete replacement is ready. Occupancy
// errors propagate to the existing per-file queue for asynchronous retries.
export async function writeStoreAtomically(path: string, value: Record<string, unknown>) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, undefined, "\t"), { flag: "wx", mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
