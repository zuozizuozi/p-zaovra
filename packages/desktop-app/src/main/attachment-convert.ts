import path from "node:path"
import { MAX_ATTACHMENT_BYTES } from "./attachment-picker"

export type ConvertedAttachment = {
  text: string
  warnings: string[]
  images: { name: string; mime: string; data: string }[]
}

export async function convertAttachment(
  input: { name: string; bytes: ArrayBuffer },
  signal?: AbortSignal,
): Promise<ConvertedAttachment> {
  signal?.throwIfAborted()
  if (!(input.bytes instanceof ArrayBuffer) || input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
    throw new Error("文件过大，请选择 100 MB 以内的附件")
  const extension = path.extname(input.name).toLowerCase()
  const buffer = Buffer.from(input.bytes)
  const warnings: string[] = []
  // Bound expanded Office archives before handing them to the document parsers.
  if ([".docx", ".xlsx", ".pptx"].includes(extension)) {
    const { BlobReader, ZipReader } = await import("@zip.js/zip.js")
    const reader = new ZipReader(new BlobReader(new Blob([input.bytes])))
    try {
      const entries = await reader.getEntries()
      if (
        entries.length > 10000 ||
        entries.reduce((size, entry) => size + entry.uncompressedSize, 0) > 100 * 1024 * 1024
      )
        throw new Error("文档展开后过大，请拆分后添加")
    } finally {
      await reader.close()
    }
  }
  const text = await (async () => {
    if (extension === ".docx") {
      const { extractRawText } = await import("mammoth")
      const result = await extractRawText({ buffer })
      warnings.push(...result.messages.map((message) => message.message))
      return result.value
    }
    if (extension === ".doc") {
      const { default: WordExtractor } = await import("word-extractor")
      return (await new WordExtractor().extract(buffer)).getBody()
    }
    if ([".xlsx", ".xls", ".ods"].includes(extension)) {
      const { read, utils } = await import("xlsx")
      const workbook = read(buffer, { type: "buffer", cellDates: true })
      return workbook.SheetNames.map((name) => `## ${name}\n\n${utils.sheet_to_csv(workbook.Sheets[name]!)}`).join(
        "\n\n",
      )
    }
    if (extension === ".ppt") {
      const { CFB } = await import("xlsx")
      const content: Uint8Array | undefined = CFB.find(
        CFB.read(buffer, { type: "buffer" }),
        "PowerPoint Document",
      )?.content
      if (!content) throw new Error("无法读取此演示文稿，请检查文件是否损坏或加密")
      return powerpointText(Buffer.from(content)).join("\n")
    }
    if (extension === ".pptx") {
      const { BlobReader, TextWriter, ZipReader } = await import("@zip.js/zip.js")
      const { SaxesParser } = await import("saxes")
      const reader = new ZipReader(new BlobReader(new Blob([input.bytes])))
      try {
        const slides = (await reader.getEntries())
          .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.filename))
          .sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))
        const pages = await Promise.all(
          slides.map(async (slide, index) => {
            if (!slide.getData) return ""
            const text: string[] = []
            let active = false
            const parser = new SaxesParser({ xmlns: true })
            parser.on("doctype", () => {
              throw new Error("演示文稿包含不支持的文档声明")
            })
            parser.on("opentag", (tag) => {
              if (tag.local === "t") active = true
            })
            parser.on("text", (value) => {
              if (active) text.push(value)
            })
            parser.on("cdata", (value) => {
              if (active) text.push(value)
            })
            parser.on("closetag", (tag) => {
              if (tag.local === "t") active = false
              if (tag.local === "p") text.push("\n")
            })
            parser.write(await slide.getData(new TextWriter())).close()
            return `## 幻灯片 ${index + 1}\n\n${text.join("")}`
          }),
        )
        return pages.join("\n\n")
      } finally {
        await reader.close()
      }
    }
    throw new Error("此类型暂不支持转换，可将原文件添加到工作区")
  })()
  signal?.throwIfAborted()
  if (text.length > 2_000_000) warnings.push("文本较长，已保留前 200 万字符；完整原文件可在工作区读取")
  return { text: text.slice(0, 2_000_000), warnings, images: [] }
}

function powerpointText(buffer: Buffer, depth = 0): string[] {
  if (depth > 64) throw new Error("演示文稿层级过深，请拆分后添加")
  const result: string[] = []
  for (let offset = 0; offset + 8 <= buffer.length; ) {
    const version = buffer.readUInt16LE(offset) & 15
    const type = buffer.readUInt16LE(offset + 2)
    const length = buffer.readUInt32LE(offset + 4)
    if (length > buffer.length - offset - 8) throw new Error("演示文稿内容不完整，请检查原文件")
    const content = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 4000) result.push(content.toString("utf16le"))
    if (type === 4008) result.push(new TextDecoder("windows-1252").decode(content))
    if (version === 15) result.push(...powerpointText(content, depth + 1))
    offset += 8 + length
  }
  return result
}
