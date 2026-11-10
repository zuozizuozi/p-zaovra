import type { Message, Part } from "@zaovra-ai/sdk/v2"
import { artifactPath } from "./artifact-path"

export type TurnDeliverable = {
  target: string
  kind: "file" | "link"
  source: "tool" | "reply"
  // A reply alone is a candidate until an exact, safe file inspection proves this turn changed it.
  after?: number
  before?: number
}

// Derive from one admitted human turn, never from a workspace inventory or file watcher.
export function turnDeliverables(input: {
  messages: readonly Message[]
  parts: Readonly<Record<string, Part[] | undefined>>
  messageID: string
  directory: string
}) {
  const start = input.messages.findIndex((message) => message.id === input.messageID)
  if (start < 0) return []
  const outputs = new Map<string, TurnDeliverable>()
  const declared = new Set<string>()
  const produced = new Set<string>()
  const logs = new Set<string>()
  const normalize = (target: string) => artifactPath(target, input.directory, /^file:\/\//i.test(target))?.path
  const following = input.messages.slice(start + 1)
  const end = following.findIndex(
    (message) =>
      message.role === "user" &&
      !(input.parts[message.id] ?? []).some((part) => part.type === "text" && part.synthetic),
  )
  const turn = end < 0 ? following : following.slice(0, end)
  const final = turn.findLast((message) => message.role === "assistant" && message.time.completed)?.id
  // A completed provider message is not the end while a later assistant is still streaming.
  const before = turn.findLast((message) => message.role === "assistant")?.time.completed
  for (const message of turn) {
    if (message.role === "user") {
      if (!(input.parts[message.id] ?? []).some((part) => part.type === "text" && part.synthetic)) break
      continue
    }
    if (message.role !== "assistant" || !message.time.completed) continue
    for (const part of input.parts[message.id] ?? []) {
      if (message.id === final && part.type === "text" && !part.synthetic && !part.ignored) {
        const markup = /\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))\)|`([^`\n]+)`/g
        const named = [...part.text.matchAll(markup)].map((match) => match[1] ?? match[2] ?? match[3])
        const bare = part.text
          .replace(markup, " ")
          .matchAll(
            /(?<![\p{L}\p{N}_/:.@])((?:[a-z]:[\\/])?[\p{L}\p{N}_./\\-]+\.(?:html?|md|pdf|png|jpe?g|gif|webp|svg|csv|json|docx?|xlsx?|pptx?|txt))(?![\p{L}\p{N}_])/giu,
          )
        for (const target of [...named, ...[...bare].map((match) => match[1])]) {
          if (/^https?:\/\//i.test(target)) {
            if (!URL.canParse(target)) continue
            const url = new URL(target)
            if (url.username || url.password) continue
            outputs.set(url.href, { target: url.href, kind: "link", source: "reply" })
            continue
          }
          const path = normalize(target)
          if (path) declared.add(path)
        }
      }
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const state = part.state
      const publish = part.tool === "publish_artifact"
      const written = part.tool === "write" || part.tool === "edit" || publish
      const target = written ? (state.input.filePath ?? state.input.path) : undefined
      if (typeof target === "string") {
        const path = normalize(target)
        if (path) {
          produced.add(path)
          // A plain edit to source code is not a delivery. Publish and renderable writes are explicit carriers.
          if (
            publish ||
            (part.tool === "write" &&
              /\.(?:html?|pdf|png|jpe?g|gif|webp|svg|ico|docx?|xlsx?|pptx?|odt|ods|odp)$/i.test(path))
          )
            outputs.set(path, { target: path, kind: "file", source: "tool" })
        }
      }
      const files: unknown = state.metadata.files
      if (part.tool === "apply_patch" && Array.isArray(files)) {
        for (const file of files as unknown[]) {
          if (!file || typeof file !== "object" || ("status" in file && file.status === "deleted")) continue
          const path = "file" in file && typeof file.file === "string" ? normalize(file.file) : undefined
          if (path) produced.add(path)
        }
      }
      // These paths carry command output logs, not the files a script created.
      const paths: unknown = state.metadata.zaovraOutputPaths
      if (Array.isArray(paths))
        for (const target of paths as unknown[]) {
          const path = typeof target === "string" ? normalize(target) : undefined
          if (path) logs.add(path)
        }
      for (const attachment of state.attachments ?? []) {
        const path = normalize(attachment.url)
        if (path) outputs.set(path, { target: path, kind: "file", source: "tool" })
      }
    }
  }
  for (const target of declared) {
    if (outputs.has(target)) continue
    if (produced.has(target)) {
      outputs.set(target, { target, kind: "file", source: "reply" })
      continue
    }
    if (logs.has(target)) continue
    const after = input.messages[start].time.created
    if (Number.isFinite(after) && after > 0)
      outputs.set(target, { target, kind: "file", source: "reply", after, ...(before ? { before } : {}) })
  }
  return [...outputs.values()]
}

export async function inspectTurnDeliverables(
  items: readonly TurnDeliverable[],
  inspect: (target: string) => Promise<{ created?: number; modified?: number } | undefined>,
) {
  return Object.fromEntries(
    await Promise.all(
      items
        .filter((item) => item.kind === "file")
        .map(async (item) => [
          item.target,
          await inspect(item.target).then(
            (info) => {
              if (item.after === undefined) return true
              const changed = Math.max(
                ...[info?.created, info?.modified].filter(
                  (time): time is number => typeof time === "number" && Number.isFinite(time),
                ),
              )
              return changed >= item.after && (item.before === undefined || changed <= item.before)
            },
            () => false,
          ),
        ]),
    ),
  ) as Record<string, boolean>
}
