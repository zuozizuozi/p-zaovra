export const ARTIFACT_LIMITS = { depth: 3, directories: 40, files: 500, entries: 2000 } as const
const excluded = new Set(["node_modules", ".git", ".next", ".cache", "coverage", "dist", "build", "vendor", ".venv"])

export async function collectArtifactFiles(
  list: (path: string) => Promise<ReadonlyArray<{ path: string; type: string }>>,
) {
  const pending = [{ path: "", depth: 0 }]
  const files = new Set<string>()
  const seen = new Set<string>()
  const errors: string[] = []
  let limited = false
  while (pending.length && seen.size < ARTIFACT_LIMITS.directories && files.size < ARTIFACT_LIMITS.files) {
    const directory = pending.shift()!
    if (seen.has(directory.path)) continue
    seen.add(directory.path)
    const entries = await list(directory.path).catch(() => {
      errors.push(directory.path || ".")
      return []
    })
    if (entries.length > ARTIFACT_LIMITS.entries) limited = true
    for (const entry of entries.slice(0, ARTIFACT_LIMITS.entries)) {
      const value = entry.path.replaceAll("\\", "/")
      const parts = value.split("/")
      if (parts.some((part) => !part || part === ".." || excluded.has(part)) || /[:\0]/.test(value)) continue
      // Only accept direct children of the directory that was actually queried.
      if (parts.slice(0, -1).join("/") !== directory.path) continue
      if (entry.type === "directory") {
        if (directory.depth >= ARTIFACT_LIMITS.depth) {
          limited = true
          continue
        }
        pending.push({ path: value, depth: directory.depth + 1 })
        continue
      }
      if (entry.type !== "file") continue
      if (files.size >= ARTIFACT_LIMITS.files) {
        limited = true
        break
      }
      files.add(value)
    }
  }
  return { files: [...files].sort(), limited: limited || pending.length > 0, errors }
}
