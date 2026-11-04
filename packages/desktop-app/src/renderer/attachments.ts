import type { ElectronAPI } from "../preload/types"

export async function prepareDesktopAttachment(
  file: File,
  api: Pick<ElectronAPI, "convertAttachment" | "storeAttachment" | "cancelAttachment">,
  signal?: AbortSignal,
  directory?: string,
) {
  signal?.throwIfAborted()
  if (file.size > 100 * 1024 * 1024) throw new Error("文件过大，请选择 100 MB 以内的附件")
  if (
    /\.(pdf|png|jpe?g|gif|webp)$/i.test(file.name) ||
    /^(image\/(?:png|jpeg|gif|webp)|application\/pdf)$/.test(file.type)
  )
    return [file]
  const office = /\.(docx?|xlsx?|pptx?|ods)$/i.test(file.name)
  const binary = /\.(zip|7z|rar|tar|gz|bz2|xz|wav|mp3|m4a|ogg|flac|aac|mp4|webm|mov|mkv|avi)$/i.test(file.name)
  if (!office && !binary) {
    const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
    const encoding =
      bytes[0] === 255 && bytes[1] === 254 ? "utf-16le" : bytes[0] === 254 && bytes[1] === 255 ? "utf-16be" : undefined
    if (encoding)
      return [new File([new TextDecoder(encoding).decode(await file.arrayBuffer())], file.name, { type: "text/plain" })]
    if (
      !bytes.some((byte) => byte === 0) &&
      bytes.filter((byte) => byte < 9 || (byte > 13 && byte < 32)).length <= bytes.length * 0.3
    )
      return [file]
  }
  const bytes = await file.arrayBuffer()
  signal?.throwIfAborted()
  const id = crypto.randomUUID()
  const abort = () => void api.cancelAttachment(id).catch(() => undefined)
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const result = office
      ? await api.convertAttachment({ id, name: file.name, bytes }).catch(() => ({
          text: "",
          warnings: ["未能提取文档文本，请用工具检查原文件是否加密或损坏"],
          images: [],
        }))
      : undefined
    signal?.throwIfAborted()
    const stored = await api.storeAttachment({ directory: directory ?? "", name: file.name, bytes })
    signal?.throwIfAborted()
    const metadata = `文件：${JSON.stringify(file.name)}\n工作区路径：${JSON.stringify(stored.path)}\n类型：${file.type || "application/octet-stream"}\n大小：${stored.size} bytes\n原始文件已保存在工作区，可用工具读取处理。\n`
    return [
      new File(
        [metadata, result ? `\n${result.warnings.map((warning) => `> ${warning}`).join("\n")}\n\n${result.text}` : ""],
        file.name,
        { type: "text/plain" },
      ),
    ]
  } finally {
    signal?.removeEventListener("abort", abort)
  }
}
