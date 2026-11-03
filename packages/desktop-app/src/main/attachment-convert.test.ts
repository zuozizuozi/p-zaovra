import { expect, test } from "bun:test"
import { convertAttachment } from "./attachment-convert"
import { CFB } from "xlsx"

test("extracts UTF-16 text from a legacy PowerPoint compound document", async () => {
  const text = Buffer.from("报价 420", "utf16le")
  const record = Buffer.alloc(8 + text.length)
  record.writeUInt16LE(4000, 2)
  record.writeUInt32LE(text.length, 4)
  text.copy(record, 8)
  const compound = CFB.utils.cfb_new()
  CFB.utils.cfb_add(compound, "PowerPoint Document", record)
  const buffer: Buffer = CFB.write(compound, { type: "buffer" })
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
  expect((await convertAttachment({ name: "legacy.ppt", bytes })).text).toContain("报价 420")
})

for (const extension of ["docx", "xlsx", "pptx"]) {
  test(`extracts real ${extension} content without Python or external commands`, async () => {
    const result = await convertAttachment({
      name: `sample.${extension}`,
      bytes: await Bun.file(`resources/attachments/fixtures/sample.${extension}`).arrayBuffer(),
    })
    expect(result.text).toContain("420")
    expect(result.images).toEqual([])
  })
}
test("rejects oversized or malformed documents and honors cancellation", async () => {
  await expect(convertAttachment({ name: "large.docx", bytes: new ArrayBuffer(101 * 1024 * 1024) })).rejects.toThrow(
    "100 MB",
  )
  await expect(convertAttachment({ name: "broken.docx", bytes: new ArrayBuffer(1) })).rejects.toThrow()
  const controller = new AbortController()
  controller.abort()
  await expect(convertAttachment({ name: "test.docx", bytes: new ArrayBuffer(1) }, controller.signal)).rejects.toThrow()
})
