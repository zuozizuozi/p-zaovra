import { expect, test } from "bun:test"
import { captureFeedbackScreenshot } from "./feedback-capture"

test("capture is explicitly requested once and rejects empty, excessive pixels, bytes and invalid data", async () => {
  let captures = 0
  const input = { width: 1, height: 1, bytes: 10, data: "data:image/png;base64,AAAA" }
  const capture = () => {
    captures++
    return Promise.resolve({
      getSize: () => ({ width: input.width, height: input.height }),
      toPNG: () => Buffer.alloc(input.bytes),
      toDataURL: () => input.data,
    })
  }
  expect(captures).toBe(0)
  expect(await captureFeedbackScreenshot(capture)).toBe(input.data)
  input.width = 0
  await expect(captureFeedbackScreenshot(capture)).rejects.toThrow("empty")
  input.width = 8_000_001
  await expect(captureFeedbackScreenshot(capture)).rejects.toThrow("large")
  input.width = 1
  input.bytes = 3_000_001
  await expect(captureFeedbackScreenshot(capture)).rejects.toThrow("large")
  input.bytes = 10
  input.data = "https://other.invalid/image.png"
  await expect(captureFeedbackScreenshot(capture)).rejects.toThrow("Invalid")
  expect(captures).toBe(5)
})
