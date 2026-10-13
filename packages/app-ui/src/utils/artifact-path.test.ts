import { expect, test } from "bun:test"
import { artifactPath, artifactPreviewable } from "./artifact-path"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

test("opens project paths with spaces, Windows case, encoding and line references", () => {
  expect(artifactPath("结果/我的图.png", "C:/work")).toEqual({ path: "结果/我的图.png", line: undefined })
  expect(artifactPath("file:///c:/WORK/src/my%20file.ts#L12", "C:/work")).toEqual({ path: "src/my file.ts", line: 12 })
  expect(artifactPath("file:///C:/work/report%20one.pdf", "C:/work")?.path).toBe("report one.pdf")
  expect(artifactPath("./src/../index.ts#L8", "/work")).toEqual({ path: "index.ts#L8", line: undefined })
})

test("rejects outside paths, traversal and dangerous schemes", () => {
  for (const input of [
    "../secret.txt",
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

test("literal file-list paths and encoded URLs open the actual special-character files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-path-"))
  await using cleanup = { [Symbol.asyncDispose]: () => fs.rm(directory, { recursive: true, force: true }) }
  for (const name of ["file#L10", "file%2E", "file%2F", "file with spaces", "中文文件", "file#L10.txt"]) {
    await fs.writeFile(path.join(directory, name), name)
    for (const input of [name, path.join(directory, name), pathToFileURL(path.join(directory, name)).href]) {
      const result = artifactPath(input, directory)
      expect(result).toEqual({ path: name, line: undefined })
      expect(await fs.readFile(path.join(directory, result!.path), "utf8")).toBe(name)
    }
    expect(artifactPath(pathToFileURL(path.join(directory, name)).href + "#L10", directory)).toEqual({
      path: name,
      line: 10,
    })
  }
  for (const input of ["%2E%2E/secret", "%2Fother/secret", "javascript%3Aalert(1)", "%00file"]) {
    expect(artifactPath(input, directory, true)).toBeUndefined()
  }
})

test("distinguishes literal percent file names from encoded links", () => {
  expect(artifactPath("100%.png", "/work")?.path).toBe("100%.png")
  expect(artifactPath("report%20one.pdf", "/work")?.path).toBe("report%20one.pdf")
  expect(artifactPath("100%25.png", "/work", true)?.path).toBe("100%.png")
  expect(artifactPath("report%20one.pdf", "/work", true)?.path).toBe("report one.pdf")
  expect(artifactPath("%2e%2e/secret.png", "/work", true)).toBeUndefined()
  expect(artifactPath("%ZZ.png", "/work", true)).toBeUndefined()
})
