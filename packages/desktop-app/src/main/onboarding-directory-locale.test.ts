import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { completeFirstLaunch } from "./onboarding-directory"

for (const [locale, folder] of [
  ["zh-CN", "Zaovra 项目"],
  ["en-US", "Zaovra Projects"],
]) {
  test("700 fresh default directory follows system locale " + locale, async () => {
    const root = await mkdtemp(join(tmpdir(), "default-directory700-"))
    try {
      const input = {
        pending: true,
        create: true,
        locale,
        exists: existsSync,
        path: (name: "documents" | "home") => join(root, name),
        mkdir: (directory: string) => mkdir(directory, { recursive: true }),
        complete: () => {},
      }
      expect(await completeFirstLaunch(input)).toEqual({ directory: join(root, "documents", folder), fallback: false })
      expect((await stat(join(root, "documents", folder))).isDirectory()).toBe(true)
    } finally {
      if (dirname(root) !== tmpdir()) throw new Error("Fixture escaped temporary directory")
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("700 existing legacy default directory and files remain in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "default-directory700-"))
  try {
    const legacy = join(root, "documents", "Default Project")
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, "notes.txt"), "keep existing work")
    const input = {
      pending: false,
      create: true,
      locale: "zh-CN",
      exists: existsSync,
      path: (name: "documents" | "home") => join(root, name),
      mkdir: (directory: string) => mkdir(directory, { recursive: true }),
      complete: () => {},
    }
    expect(await completeFirstLaunch(input)).toEqual({ directory: legacy, fallback: false })
    expect(await Bun.file(join(legacy, "notes.txt")).text()).toBe("keep existing work")
    expect(existsSync(join(root, "documents", "Zaovra 项目"))).toBe(false)
  } finally {
    if (dirname(root) !== tmpdir()) throw new Error("Fixture escaped temporary directory")
    await rm(root, { recursive: true, force: true })
  }
})
