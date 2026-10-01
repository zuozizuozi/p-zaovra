import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import path from "node:path"
import os from "node:os"
import { collectArtifactFiles } from "./artifact-files"

test("discovers actual non-Git files created by direct writes and scripts, and removes deleted entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "artifact-files-"))
  try {
    const list = async (dir: string) =>
      (await readdir(path.join(root, dir), { withFileTypes: true })).map((entry) => ({
        path: [dir, entry.name].filter(Boolean).join("/"),
        type: entry.isDirectory() ? "directory" : "file",
      }))
    await writeFile(path.join(root, "old.txt"), "old")
    const before = await collectArtifactFiles(list)
    await mkdir(path.join(root, "results"))
    await writeFile(path.join(root, "results", "edited.md"), "direct mutation")
    execFileSync(process.execPath, ["-e", "require('node:fs').writeFileSync('results/script.png','fixture')"], {
      cwd: root,
    })
    expect(before.files).toEqual(["old.txt"])
    expect((await collectArtifactFiles(list)).files).toEqual(["old.txt", "results/edited.md", "results/script.png"])
    await rm(path.join(root, "results", "script.png"))
    expect((await collectArtifactFiles(list)).files).not.toContain("results/script.png")
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw Error("Unexpected fixture directory")
    await rm(root, { recursive: true, force: true })
  }
})

test("bounds directory traversal and skips dependencies, caches and escaping entries", async () => {
  const visited: string[] = []
  const result = await collectArtifactFiles(async (dir) => {
    visited.push(dir)
    if (!dir)
      return ["node_modules", ".git", "dist", ".cache", "build", "a"]
        .map((path) => ({ path, type: "directory" }))
        .concat([{ path: "../secret", type: "file" }])
    return [
      { path: dir + "/next", type: "directory" },
      { path: dir + "/ok.png", type: "file" },
    ]
  })
  expect(visited).toEqual(["", "a", "a/next", "a/next/next"])
  expect(result.limited).toBe(true)
  expect(result.files.length).toBe(3)
})

test("caps files and directories and reports errors without claiming an empty complete result", async () => {
  const files = await collectArtifactFiles(async () =>
    Array.from({ length: 2200 }, (_, i) => ({ path: `${i}.png`, type: "file" })),
  )
  expect(files.files.length).toBe(500)
  expect(files.limited).toBe(true)
  let calls = 0
  const directories = await collectArtifactFiles(async (dir) => {
    calls++
    return dir ? [] : Array.from({ length: 60 }, (_, i) => ({ path: `d${i}`, type: "directory" }))
  })
  expect(calls).toBe(40)
  expect(directories.limited).toBe(true)
  const failed = await collectArtifactFiles(async () => {
    throw Error("unavailable")
  })
  expect(failed.errors).toEqual(["."])
})
