import { isAbsolute, join } from "node:path"

export async function completeFirstLaunch(input: {
  pending: boolean
  create: boolean
  locale?: string
  exists?: (directory: string) => boolean
  path: (name: "documents" | "home") => string
  mkdir: (path: string) => Promise<unknown>
  complete: () => void
}): Promise<null | { directory: string; fallback: boolean } | { needsDirectory: true }> {
  if (!input.pending && !input.create) return null
  if (!input.create) {
    input.complete()
    return null
  }
  for (const name of ["documents", "home"] as const) {
    let directory: string
    try {
      const root = input.path(name)
      if (!root || !isAbsolute(root)) continue
      const legacy = join(root, "Default Project")
      directory = input.exists?.(legacy)
        ? legacy
        : join(root, input.locale?.startsWith("zh") ? "Zaovra 项目" : "Zaovra Projects")
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
