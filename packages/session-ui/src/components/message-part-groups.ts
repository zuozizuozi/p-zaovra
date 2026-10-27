import type { Part as PartType } from "@zaovra-ai/sdk/v2"

export const contextGroupTools = new Set(["read", "glob", "grep", "list"])

export type PartRef = {
  messageID: string
  partID: string
}

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      kind?: "edit" | "browser" | "command"
      refs: PartRef[]
    }

function sameRef(a: PartRef, b: PartRef) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function sameGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.type !== b.type) return false
  if (a.type === "part") {
    if (b.type !== "part") return false
    return sameRef(a.ref, b.ref)
  }
  if (b.type !== "context") return false
  if (a.kind !== b.kind) return false
  if (a.refs.length !== b.refs.length) return false
  return a.refs.every((ref, i) => sameRef(ref, b.refs[i]!))
}

export function sameGroups(a: readonly PartGroup[] | undefined, b: readonly PartGroup[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, i) => sameGroup(item, b[i]!))
}

export function groupParts(parts: { messageID: string; part: PartType }[], process = false) {
  const kind = (part: PartType) => {
    if (part.type === "tool" && part.state.status !== "error" && contextGroupTools.has(part.tool)) return "context"
    if (!process || part.type !== "tool" || part.state.status !== "completed") return
    if (["write", "edit", "apply_patch"].includes(part.tool)) return "edit"
    if (["bash", "bash_job"].includes(part.tool)) return "command"
    if (part.tool.startsWith("browser")) return "browser"
  }
  const result: PartGroup[] = []
  let start = -1

  const flush = (end: number) => {
    if (start < 0) return
    const first = parts[start]
    const last = parts[end]
    if (!first || !last) {
      start = -1
      return
    }
    result.push({
      key: `context:${first.part.id}`,
      type: "context",
      ...(kind(first.part) !== "context" ? { kind: kind(first.part) as "edit" | "browser" | "command" } : {}),
      refs: parts.slice(start, end + 1).map((item) => ({
        messageID: item.messageID,
        partID: item.part.id,
      })),
    })
    start = -1
  }

  parts.forEach((item, index) => {
    if (kind(item.part)) {
      if (start >= 0 && kind(parts[start].part) !== kind(item.part)) flush(index - 1)
      if (start < 0) start = index
      return
    }

    flush(index - 1)
    result.push({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part",
      ref: {
        messageID: item.messageID,
        partID: item.part.id,
      },
    })
  })

  flush(parts.length - 1)
  return result
}
