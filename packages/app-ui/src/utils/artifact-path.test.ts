import { expect, test } from "bun:test"
import { artifactPath, artifactPreviewable } from "./artifact-path"

test("opens project paths with spaces, Windows case, encoding and line references", () => {
  expect(artifactPath("结果/我的图.png", "C:/work")).toEqual({ path: "结果/我的图.png", line: undefined })
  expect(artifactPath("c:\\WORK\\src\\my file.ts:12", "C:/work")).toEqual({ path: "src/my file.ts", line: 12 })
  expect(artifactPath("file:///C:/work/report%20one.pdf", "C:/work")?.path).toBe("report one.pdf")
  expect(artifactPath("./src/../index.ts#L8", "/work")?.line).toBe(8)
})

test("rejects outside paths, traversal and dangerous schemes", () => {
  for (const input of [
    "../secret.txt",
    "%2e%2e/secret.txt",
    "C:/work-other/a.png",
    "D:/work/a.png",
    "javascript:alert(1)",
    "https://example.com/a.png",
    "//server/share/a.png",
    "a/../../secret.txt",
    "a\u0000.png",
  ]) {
    expect(artifactPath(input, "C:/work")).toBeUndefined()
  }
  expect(artifactPreviewable("image.PNG")).toBe(true)
  expect(artifactPreviewable("report.pdf")).toBe(true)
  expect(artifactPreviewable("report.docx")).toBe(false)
})
