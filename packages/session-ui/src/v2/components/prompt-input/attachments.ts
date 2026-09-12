import { onMount, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { PromptInputV2Attachment, PromptInputV2Prompt } from "./types"

const accepted = [
  ".docx",
  ".xlsx",
  ".pptx",
  ".zip",
  ".wav",
  ".mp3",
  ".m4a",
  ".ogg",
  ".flac",
  ".aac",
  ".mp4",
  ".webm",
  ".mov",
  ".mkv",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/*",
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  ".c",
  ".cc",
  ".cjs",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".cts",
  ".env",
  ".go",
  ".gql",
  ".graphql",
  ".h",
  ".hh",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]

type PromptTarget = {
  current: () => PromptInputV2Prompt
  cursor: () => number | undefined
  set: (prompt: PromptInputV2Prompt, cursor?: number) => void
}

export type PromptInputV2AttachmentConfig = {
  prepare?: (file: File, signal?: AbortSignal) => Promise<File[]>
  identity?: () => unknown
  picker?: (
    options: { defaultPath?: string; multiple?: boolean; accept?: string[] },
    onFile: (file: File) => Promise<unknown>,
  ) => Promise<void>
  directory: () => string
  isDialogActive: () => boolean
  warn: () => void
  onError: (error: unknown) => void
  readClipboardImage?: () => Promise<File | null>
  getPathForFile?: (file: File) => string
}

export function createPromptInputV2Attachments(
  input: PromptInputV2AttachmentConfig & {
    capture: () => PromptTarget
    editor: () => HTMLElement | undefined
    focusEditor: () => void
    addPart: (part: PromptInputV2Prompt[number]) => boolean
    setDraggingType: (type: "image" | "@mention" | null) => void
  },
) {
  const [jobs, setJobs] = createStore<
    { id: number; name: string; state: "processing" | "error"; error?: string; retry: () => void }[]
  >([])
  let sequence = 0
  const controllers = new Map<number, AbortController>()
  onCleanup(() => {
    controllers.forEach((controller) => controller.abort())
    controllers.clear()
    setJobs([])
  })
  const capture = () => {
    const prompt = input.capture()
    const editor = input.editor()
    if (!editor) return
    return { prompt, cursor: prompt.cursor() ?? cursorPosition(editor), identity: input.identity?.() }
  }
  const addReady = async (file: File, toast = true, target = capture()) => {
    if (!target) return false
    const mime = await attachmentMime(file)
    if (!mime) {
      if (toast) input.warn()
      return false
    }
    const url = await dataUrl(file, mime)
    if (!url) return false
    const attachment: PromptInputV2Attachment = {
      type: "image",
      id: globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2),
      filename: file.name,
      sourcePath: input.getPathForFile?.(file) || undefined,
      mime,
      dataUrl: url,
    }
    return attachment
  }
  const add = async (file: File, toast = true, target = capture()): Promise<boolean> => {
    if (!target) return false
    const id = ++sequence
    const identity = target.identity
    const attempt = async () => {
      if (controllers.has(id)) return false
      const controller = new AbortController()
      controllers.set(id, controller)
      setJobs((items) => [
        ...items.filter((item) => item.id !== id),
        { id, name: file.name, state: "processing", retry: () => void attempt() },
      ])
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error("附件不能超过 20 MB")
        const files = input.prepare ? await input.prepare(file, controller.signal) : [file]
        if (!jobs.some((item) => item.id === id)) return false
        if (input.identity?.() !== identity) throw new Error("已切换会话，请移除此附件并在目标会话重新添加")
        const parts: PromptInputV2Attachment[] = []
        for (const prepared of files) {
          const part = await addReady(prepared, false, target)
          if (!part) throw new Error("此文件无法读取，请检查格式或安装附件组件")
          parts.push(part)
        }
        if (!jobs.some((item) => item.id === id)) return false
        if (input.identity?.() !== identity) throw new Error("已切换会话，请移除此附件并在目标会话重新添加")
        target.prompt.set([...target.prompt.current(), ...parts], target.cursor)
        setJobs((items) => items.filter((item) => item.id !== id))
        return true
      } catch (error) {
        setJobs((item) => item.id === id, {
          state: "error",
          error: error instanceof Error ? error.message : String(error),
        })
        return false
      } finally {
        controllers.delete(id)
      }
    }
    return attempt()
  }
  const addAttachments = async (files: File[], toast = true, target = capture()) => {
    if (files.reduce((size, file) => size + file.size, 0) > 20 * 1024 * 1024) {
      input.onError(new Error("每批附件合计不能超过 20 MB，请分批添加"))
      return false
    }
    const found = await files.reduce(async (result, file) => {
      const previous = await result
      if (input.identity?.() !== target?.identity) return previous
      return (await add(file, false, target)) || previous
    }, Promise.resolve(false))
    return found
  }
  const handlePaste = async (event: ClipboardEvent) => {
    const clipboardData = event.clipboardData
    if (!clipboardData) return
    const target = capture()
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    const files = Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })
    if (files.length > 0) {
      await addAttachments(files, true, target)
      return
    }
    const plainText = clipboardData.getData("text/plain") ?? ""
    if (input.readClipboardImage && !plainText) {
      const file = await input.readClipboardImage()
      if (file && (await add(file, true, target))) return
    }
    if (!plainText) return
    const text = plainText.includes("\r") ? plainText.replace(/\r\n?/g, "\n") : plainText
    const put = () => {
      if (input.addPart({ type: "text", content: text, start: 0, end: 0 })) return true
      input.focusEditor()
      return input.addPart({ type: "text", content: text, start: 0, end: 0 })
    }
    if (text.includes("\n") || largePaste(text)) {
      put()
      return
    }
    if (typeof document.execCommand === "function" && document.execCommand("insertText", false, text)) return
    put()
  }
  const handleDrop = async (event: DragEvent) => {
    if (input.isDialogActive()) return
    event.preventDefault()
    event.stopPropagation()
    input.setDraggingType(null)
    const plainText = event.dataTransfer?.getData("text/plain")
    if (plainText?.startsWith("file:")) {
      const path = plainText.slice("file:".length)
      input.focusEditor()
      input.addPart({ type: "file", path, content: `@${path}`, start: 0, end: 0 })
      return
    }
    const files = event.dataTransfer?.files
    if (files) await addAttachments(Array.from(files))
  }

  onMount(() => {
    makeEventListener(document, "dragover", (event) => {
      if (input.isDialogActive()) return
      event.preventDefault()
      if (event.dataTransfer?.types.includes("Files")) input.setDraggingType("image")
      else if (event.dataTransfer?.types.includes("text/plain")) input.setDraggingType("@mention")
    })
    makeEventListener(document, "dragleave", (event) => {
      if (!input.isDialogActive() && !event.relatedTarget) input.setDraggingType(null)
    })
    makeEventListener(document, "drop", handleDrop)
  })

  return {
    jobs: () => jobs,
    busy: () => jobs.length > 0,
    dismiss: (id: number) => {
      controllers.get(id)?.abort()
      setJobs((items) => items.filter((item) => item.id !== id))
    },
    addAttachments,
    handlePaste,
    handleDrop,
    pick(fallback: () => void) {
      if (!input.picker) {
        fallback()
        return
      }
      const target = capture()
      void input
        .picker({ defaultPath: input.directory(), multiple: true, accept: accepted }, (file) =>
          input.identity?.() === target?.identity ? add(file, true, target) : Promise.resolve(false),
        )
        .catch(input.onError)
    },
  }
}

function dataUrl(file: File, mime: string) {
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => resolve(""))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const index = value.indexOf(",")
      resolve(index === -1 ? value : `data:${mime};base64,${value.slice(index + 1)}`)
    })
    reader.readAsDataURL(file)
  })
}

const imageMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const imageExtensions = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])
const textMimes = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
])

async function attachmentMime(file: File) {
  const type = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (imageMimes.has(type) || type === "application/pdf") return type
  const index = file.name.lastIndexOf(".")
  const suffix = index === -1 ? "" : file.name.slice(index + 1).toLowerCase()
  const fallback = imageExtensions.get(suffix) ?? (suffix === "pdf" ? "application/pdf" : undefined)
  if ((!type || type === "application/octet-stream") && fallback) return fallback
  if (type.startsWith("text/") || textMimes.has(type) || type.endsWith("+json") || type.endsWith("+xml")) {
    return "text/plain"
  }
  const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  if (bytes.some((byte) => byte === 0)) return
  const control = bytes.filter((byte) => byte < 9 || (byte > 13 && byte < 32)).length
  if (bytes.length > 0 && control / bytes.length > 0.3) return
  return "text/plain"
}

function cursorPosition(editor: HTMLElement) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!editor.contains(range.startContainer)) return 0
  const before = range.cloneRange()
  before.selectNodeContents(editor)
  before.setEnd(range.startContainer, range.startOffset)
  return before.toString().replace(/\u200B/g, "").length
}

function largePaste(text: string) {
  if (text.length >= 8000) return true
  return text.split("\n").length - 1 >= 120
}
