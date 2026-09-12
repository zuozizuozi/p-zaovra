import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { convertAttachment } from "./attachment-convert"

const runtime = {
  python: resolve("../../.cache/attachment-python/Scripts/python.exe"),
  script: resolve("resources/attachments/convert.py"),
  models: resolve("../../.cache/attachment-python/models"),
}

const integration = test.skipIf(!(await Bun.file(runtime.python).exists()))

for (const extension of ["docx", "xlsx", "pptx", "zip"]) {
  integration(
    `reads actual ${extension} attachment content`,
    async () => {
      const result = await convertAttachment(
        {
          name: `sample.${extension}`,
          bytes: await Bun.file(`resources/attachments/fixtures/sample.${extension}`).arrayBuffer(),
        },
        runtime,
      )
      expect(result.text).toContain("420")
      if (extension === "zip") expect(result.warnings.join(" ")).toContain("skip.exe")
    },
    60000,
  )
}

integration("rejects unsafe archive members without extracting them", async () => {
  await expect(
    convertAttachment(
      { name: "unsafe.zip", bytes: await Bun.file("resources/attachments/fixtures/unsafe.zip").arrayBuffer() },
      runtime,
    ),
  ).rejects.toThrow("不安全路径")
})

test("rejects unsupported files and oversized data before launching a worker", async () => {
  await expect(convertAttachment({ name: "bad.exe", bytes: new ArrayBuffer(4) }, runtime)).rejects.toThrow("暂不支持")
  await expect(
    convertAttachment({ name: "bad.docx", bytes: new ArrayBuffer(21 * 1024 * 1024) }, runtime),
  ).rejects.toThrow("20 MB")
})

const advanced = test.skipIf(!(await Bun.file(`${runtime.models}/whisper-small/model.bin`).exists()))
advanced(
  "transcribes real speech with timestamps",
  async () => {
    const result = await convertAttachment(
      { name: "speech.wav", bytes: await Bun.file("resources/attachments/fixtures/speech.wav").arrayBuffer() },
      runtime,
    )
    expect(result.text).toContain("420")
    expect(result.text).toContain("[0.0s")
  },
  120000,
)
advanced(
  "reads a scanned PDF using local OCR",
  async () => {
    const result = await convertAttachment(
      { name: "scan.pdf", bytes: await Bun.file("resources/attachments/fixtures/scan.pdf").arrayBuffer() },
      runtime,
    )
    expect(result.text).toContain("420")
    expect(result.warnings.join(" ")).toContain("文字识别")
  },
  120000,
)
integration(
  "extracts a frame from a short video without an audio track",
  async () => {
    const result = await convertAttachment(
      { name: "silent.mp4", bytes: await Bun.file("resources/attachments/fixtures/silent.mp4").arrayBuffer() },
      runtime,
    )
    expect(result.images.length).toBe(1)
    expect(result.images[0]?.name).toContain("0.0s")
    expect(result.warnings.join(" ")).toContain("未识别到语音")
  },
  30000,
)
integration("honors cancellation before starting conversion", async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(
    convertAttachment(
      { name: "scan.pdf", bytes: await Bun.file("resources/attachments/fixtures/scan.pdf").arrayBuffer() },
      runtime,
      controller.signal,
    ),
  ).rejects.toThrow()
})
