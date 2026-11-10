import type { Message, Part } from "@zaovra-ai/sdk/v2"
import { artifactPath } from "./artifact-path"

export type TurnDeliverable = { target: string; kind: "file" | "link"; source: "tool" | "reply" }

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
  const normalize = (target: string) => artifactPath(target, input.directory, /^file:\/\//i.test(target))?.path
  for (const message of input.messages.slice(start + 1)) {
    if (message.role === "user") {
      if (!(input.parts[message.id] ?? []).some((part) => part.type === "text" && part.synthetic)) break
      continue
    }
    if (message.role !== "assistant" || !message.time.completed) continue
    for (const part of input.parts[message.id] ?? []) {
      if (part.type === "text" && !part.synthetic && !part.ignored) {
        // Only explicit Markdown links and path code spans count as declared outputs.
        for (const match of part.text.matchAll(/\[[^\]\n]*\]\(<?([^\s)>]+)>?\)|`([^`\n]+)`/g)) {
          const target = match[1] ?? match[2]
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
      // Retained command logs are candidates only when the final reply explicitly names them.
      const paths: unknown = state.metadata.zaovraOutputPaths
      if (Array.isArray(paths))
        for (const target of paths as unknown[]) {
          const path = typeof target === "string" ? normalize(target) : undefined
          if (path) produced.add(path)
        }
      for (const attachment of state.attachments ?? []) {
        const path = normalize(attachment.url)
        if (path) outputs.set(path, { target: path, kind: "file", source: "tool" })
      }
    }
  }
  for (const target of declared)
    if (produced.has(target)) outputs.set(target, { target, kind: "file", source: "reply" })
  return [...outputs.values()]
}
