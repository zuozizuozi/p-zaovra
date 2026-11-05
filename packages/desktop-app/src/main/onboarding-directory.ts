import { isAbsolute, join } from "node:path"

export async function completeFirstLaunch(input: {
  pending: boolean
  create: boolean
  path: (name: "documents" | "home") => string
  mkdir: (path: string) => Promise<unknown>
  complete: () => void
}): Promise<null | { directory: string; fallback: boolean } | { needsDirectory: true }> {
  if (!input.pending) return null
  if (!input.create) {
    input.complete()
    return null
  }
  for (const name of ["documents", "home"] as const) {
    let directory: string
    try {
      const root = input.path(name)
      if (!root || !isAbsolute(root)) continue
      directory = join(root, "Default Project")
      await input.mkdir(directory)
    } catch {
      // Known-folder lookup and directory creation can both fail on Windows.
      // Leave completion pending until a usable directory or explicit skip.
      continue
    }
    input.complete()
    return { directory, fallback: name === "home" }
  }
  return { needsDirectory: true }
}
