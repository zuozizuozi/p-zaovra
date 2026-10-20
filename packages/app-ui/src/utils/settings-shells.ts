import { createResource } from "solid-js"

export function createSettingsShells<T>(
  source: () => { directory?: string; configured?: string; read: (directory: string) => Promise<T[]> },
  failure: () => string,
) {
  return createResource(source, async (input) => {
    if (!input.directory) return { items: [] as T[], error: undefined }
    return input.read(input.directory)
      .then((items) => ({ items, error: undefined }))
      .catch(() => ({ items: [] as T[], error: failure() }))
  }, { initialValue: { items: [] as T[], error: undefined as string | undefined } })
}
