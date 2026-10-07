/** Read raw storage before hydration can replace malformed data with defaults. */
export function isEmptyDraftPrompt(raw: string | null) {
  if (raw === null) return true
  try {
    const value: unknown = JSON.parse(raw)
    return (
      value !== null &&
      typeof value === "object" &&
      "prompt" in value &&
      Array.isArray(value.prompt) &&
      value.prompt.every(
        (part: unknown) =>
          part !== null &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "text" &&
          "content" in part &&
          part.content === "",
      ) &&
      "context" in value &&
      value.context !== null &&
      typeof value.context === "object" &&
      "items" in value.context &&
      Array.isArray(value.context.items) &&
      value.context.items.length === 0
    )
  } catch {
    return false
  }
}

export async function cleanupEmptyDrafts(input: {
  ids: string[]
  read: (id: string) => Promise<string | null>
  canRemove: (id: string) => boolean
  remove: (id: string) => void
}) {
  // A failed read preserves that tab and does not block cleanup of other tabs.
  await Promise.allSettled(
    input.ids.map(async (id) => {
      const raw = await input.read(id)
      if (isEmptyDraftPrompt(raw) && input.canRemove(id)) input.remove(id)
    }),
  )
}
