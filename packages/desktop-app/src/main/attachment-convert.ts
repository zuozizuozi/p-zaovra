import { execFile } from "node:child_process"
import { mkdtemp, writeFile, rm, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MAX_ATTACHMENT_BYTES } from "./attachment-picker"

export type ConvertedAttachment = {
  text: string
  warnings: string[]
  images: { name: string; mime: string; data: string }[]
}

const supported = new Set([
  ".docx",
  ".xlsx",
  ".pptx",
  ".pdf",
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
])

export async function convertAttachment(
  input: { name: string; bytes: ArrayBuffer },
  runtime: { python: string; script: string; models: string },
  signal?: AbortSignal,
) {
  const extension = path.extname(input.name).toLowerCase()
  if (!supported.has(extension)) throw new Error("暂不支持此附件类型")
  if (!(input.bytes instanceof ArrayBuffer) || input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
    throw new Error("附件不能超过 20 MB")
  if (
    !(await access(runtime.python).then(
      () => true,
      () => false,
    ))
  )
    throw new Error("请先运行附件组件安装脚本，再重试此附件")
  const directory = await mkdtemp(path.join(tmpdir(), "zaovra-attachment-"))
  try {
    const file = path.join(directory, `input${extension}`)
    await writeFile(file, new Uint8Array(input.bytes))
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        runtime.python,
        [runtime.script, file],
        {
          signal,
          windowsHide: true,
          timeout: 10 * 60 * 1000,
          maxBuffer: 12 * 1024 * 1024,
          env: { ...process.env, PYTHONUTF8: "1", ZAOVRA_ATTACHMENT_MODELS: runtime.models, HF_HUB_OFFLINE: "1" },
        },
        (error, stdout) => {
          if (error && !stdout.trim())
            return reject(
              new Error(error.killed ? "解析超时，请拆分文件后重试" : "附件解析进程失败，请检查附件组件安装情况"),
            )
          resolve(stdout)
        },
      )
    })
    const result = JSON.parse(output) as ConvertedAttachment & { ok: boolean; error?: string }
    if (!result.ok) throw new Error(result.error || "无法解析此附件")
    if (typeof result.text !== "string" || !Array.isArray(result.warnings) || !Array.isArray(result.images))
      throw new Error("附件解析结果无效")
    return { text: result.text, warnings: result.warnings, images: result.images }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
