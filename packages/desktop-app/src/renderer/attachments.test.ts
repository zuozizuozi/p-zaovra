import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { prepareDesktopAttachment } from "./attachments"
import { convertAttachment } from "../main/attachment-convert"
import { storeAttachment } from "../main/attachment-store"

const api = { convertAttachment, storeAttachment, cancelAttachment: async () => {} }
test("decodes Windows UTF-16 text files before attaching them", async () => {
  const result = await prepareDesktopAttachment(new File([Buffer.from("\ufeff报价,420", "utf16le")], "报价.csv"), api)
  expect(await result[0]!.text()).toBe("报价,420")
  expect(result[0]!.type.split(";")[0]).toBe("text/plain")
})
for (const name of ["image.png", "document.pdf", "sample.csv", "readme.md", "code.ts"]) {
  test(`preserves native or text attachment ${name}`, async () => {
    const file = new File(["native content 420"], name)
    expect(await prepareDesktopAttachment(file, api)).toEqual([file])
  })
}
for (const name of ["speech.wav", "movie.mp4", "archive.zip", "unknown.bin", "photo.bmp"]) {
  test(`stores ${name} in the actual workspace and attaches metadata`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "attachment-workspace-"))
    try {
      const content = new Uint8Array([0, 1, 2, 3])
      const result = await prepareDesktopAttachment(
        new File([content], name, { type: name.endsWith("bmp") ? "image/bmp" : "" }),
        api,
        undefined,
        directory,
      )
      const metadata = await result[0]!.text()
      expect(metadata).toContain(name)
      expect(metadata).toContain("4 bytes")
      const target = JSON.parse(metadata.split("\n")[1]!.slice("工作区路径：".length))
      expect(await Bun.file(target).bytes()).toEqual(content)
      expect(path.relative(directory, target)).toStartWith(".zaovra")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
test("Word conversion carries real extracted content and the original workspace file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "attachment-word-"))
  try {
    const result = await prepareDesktopAttachment(
      new File([await Bun.file("resources/attachments/fixtures/sample.docx").arrayBuffer()], "sample.docx"),
      api,
      undefined,
      directory,
    )
    expect(await result[0]!.text()).toContain("420")
    expect(await result[0]!.text()).toContain("工作区路径")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a damaged Office document remains available as a workspace file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "attachment-damaged-"))
  try {
    const result = await prepareDesktopAttachment(
      new File([new Uint8Array([0, 1, 2])], "damaged.docx"),
      api,
      undefined,
      directory,
    )
    expect(await result[0]!.text()).toContain("未能提取文档文本")
    expect(await result[0]!.text()).toContain("工作区路径")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
