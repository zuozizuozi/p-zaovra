import { isRecord } from "../../utils/record"

export class UnsupportedToolSchema extends Error {}

export function resolveLocalReference(root: Record<string, unknown>, ref: string, active: ReadonlySet<string>) {
  const fragment = ref.startsWith("#") ? decodeFragment(ref.slice(1)) : undefined
  if (fragment === undefined || (fragment !== "" && !fragment.startsWith("/")))
    throw new UnsupportedToolSchema("only local JSON Pointer references can be projected")
  if (active.has(fragment)) throw new UnsupportedToolSchema("recursive schema reference cannot be projected")

  let target: unknown = root
  for (const segment of fragment === "" ? [] : fragment.slice(1).split("/")) {
    if (/~(?![01])/.test(segment)) throw new UnsupportedToolSchema("invalid schema reference pointer")
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~")
    if ((!isRecord(target) && !Array.isArray(target)) || !Object.hasOwn(target, key))
      throw new UnsupportedToolSchema("unresolved local schema reference")
    target = (target as Record<string, unknown>)[key]
    if (isRecord(target) && Object.hasOwn(target, "$id"))
      throw new UnsupportedToolSchema("a referenced schema changes the base identifier")
  }
  if (!isRecord(target)) throw new UnsupportedToolSchema("schema reference must point to a schema object")
  return { target, active: new Set([...active, fragment]) }
}

function decodeFragment(fragment: string) {
  try {
    return decodeURIComponent(fragment)
  } catch {
    return undefined
  }
}

export function referenceAnnotations(schema: Record<string, unknown>, target: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => {
      if (["$ref", "$defs", "definitions", "$schema", "$comment", "$id"].includes(key)) return false
      if (["title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"].includes(key))
        return true
      if (key === "type" && typeof schema.type === "string" && schema.type === target.type) return false
      throw new UnsupportedToolSchema("constraints beside a schema reference cannot be projected")
    }),
  )
}
