import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { completeFirstLaunch } from "./onboarding-directory"

test("fresh profile creates Documents/Default Project and completes only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "first-launch-"))
  let pending = true
  const input = {
    pending,
    create: true,
    path: (name: "documents" | "home") => join(root, name),
    mkdir: (directory: string) => mkdir(directory, { recursive: true }),
    complete: () => {
      pending = false
    },
  }
  try {
    const result = await completeFirstLaunch(input)
    expect(result).toEqual({ directory: join(root, "documents", "Default Project"), fallback: false })
    expect((await stat(join(root, "documents", "Default Project"))).isDirectory()).toBe(true)
    expect(pending).toBe(false)
    expect(await completeFirstLaunch({ ...input, pending })).toBe(null)
    expect(await Bun.file(join(root, "home")).exists()).toBe(false)
  } finally {
    await cleanup(root)
  }
})

test("unavailable Documents falls back to home without requiring a model", async () => {
  const root = await mkdtemp(join(tmpdir(), "first-launch-"))
  let completed = false
  try {
    await writeFile(join(root, "documents"), "blocked known folder")
    expect(
      await completeFirstLaunch({
        pending: true,
        create: true,
        path: (name) => join(root, name),
        mkdir: (directory) => mkdir(directory, { recursive: true }),
        complete: () => {
          completed = true
        },
      }),
    ).toEqual({ directory: join(root, "home", "Default Project"), fallback: true })
    expect((await stat(join(root, "home", "Default Project"))).isDirectory()).toBe(true)
    expect(completed).toBe(true)
  } finally {
    await cleanup(root)
  }
})

test("only failure of both known folders requests a location and keeps first launch pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "first-launch-"))
  let completed = false
  try {
    await Promise.all(["documents", "home"].map((name) => writeFile(join(root, name), "blocked")))
    expect(
      await completeFirstLaunch({
        pending: true,
        create: true,
        path: (name) => join(root, name),
        mkdir: (directory) => mkdir(directory, { recursive: true }),
        complete: () => {
          completed = true
        },
      }),
    ).toEqual({ needsDirectory: true })
    expect(completed).toBe(false)
  } finally {
    await cleanup(root)
  }
})

test("explicit selection completes without creating another directory; restart is a no-op", async () => {
  let pending = true
  const input = {
    create: false,
    path: () => {
      throw new Error("unexpected path lookup")
    },
    mkdir: async () => {
      throw new Error("unexpected directory creation")
    },
    complete: () => {
      pending = false
    },
  }
  expect(await completeFirstLaunch({ ...input, pending })).toBe(null)
  expect(pending).toBe(false)
  expect(await completeFirstLaunch({ ...input, pending, create: true })).toBe(null)
})

test("completion storage errors stay visible instead of creating a second project", async () => {
  const root = await mkdtemp(join(tmpdir(), "first-launch-"))
  try {
    await expect(
      completeFirstLaunch({
        pending: true,
        create: true,
        path: (name) => join(root, name),
        mkdir: (directory) => mkdir(directory, { recursive: true }),
        complete: () => {
          throw new Error("store unavailable")
        },
      }),
    ).rejects.toThrow("store unavailable")
    expect((await stat(join(root, "documents", "Default Project"))).isDirectory()).toBe(true)
    expect(await Bun.file(join(root, "home")).exists()).toBe(false)
  } finally {
    await cleanup(root)
  }
})

async function cleanup(root: string) {
  if (dirname(root) !== tmpdir()) throw new Error("Fixture path escaped its temporary directory")
  await rm(root, { recursive: true, force: true })
}
