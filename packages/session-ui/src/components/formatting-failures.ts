export function formattingFailures(metadata: unknown): string[] {
  return failures(metadata, "formatting")
}

export function diagnosticFailures(metadata: unknown): string[] {
  return failures(metadata, "lsp")
}

function failures(metadata: unknown, field: "formatting" | "lsp"): string[] {
  if (!metadata || typeof metadata !== "object") return []
  const direct = failed((metadata as Record<string, unknown>)[field])
  const applied = "applied" in metadata && Array.isArray(metadata.applied) ? metadata.applied : []
  return [
    ...direct,
    ...applied.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return []
      const resource = "resource" in item && typeof item.resource === "string" ? item.resource : ""
      return failed((item as Record<string, unknown>)[field]).map((name) => (resource ? `${resource}: ${name}` : name))
    }),
  ]
}

function failed(value: unknown): string[] {
  if (!value || typeof value !== "object" || !("failed" in value) || !Array.isArray(value.failed)) return []
  return value.failed.filter((name: unknown): name is string => typeof name === "string" && name.length > 0)
}
