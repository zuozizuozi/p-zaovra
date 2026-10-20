import { expect, test } from "bun:test"
import { join } from "node:path"
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { completeFirstLaunch } from "./onboarding-directory"

test("a real filesystem collision preserves the file and creates a fallback directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "zaovra-onboarding-"))
  try {
    await writeFile(join(root, "documents"), "not a directory")
    let completed = false
    const result = await completeFirstLaunch({
      pending: true,
      create: true,
      path: (name) => join(root, name),
      mkdir: (directory) => mkdir(directory, { recursive: true }),
      complete: () => {
        completed = true
      },
    })
    expect(result).toEqual({ directory: join(root, "home", "Default Project"), fallback: true })
    expect((await stat(join(root, "home", "Default Project"))).isDirectory()).toBe(true)
    expect(await Bun.file(join(root, "documents")).text()).toBe("not a directory")
    expect(completed).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("documents failure falls back to a child of home before marking complete", async () => {
  const events: string[] = []
  const result = await completeFirstLaunch({
    pending: true,
    create: true,
    path: (name) => {
      if (name === "documents") throw new Error("unavailable")
      return "F:/isolated-home"
    },
    mkdir: async (path) => {
      events.push(path)
    },
    complete: () => {
      events.push("complete")
    },
  })
  expect(result).toEqual({ directory: join("F:/isolated-home", "Default Project"), fallback: true })
  expect(events).toEqual([join("F:/isolated-home", "Default Project"), "complete"])
})

test("mkdir denial also falls back; both failures leave onboarding pending", async () => {
  let completed = false
  const result = await completeFirstLaunch({
    pending: true,
    create: true,
    path: (name) => `F:/${name}`,
    mkdir: async () => {
      throw new Error("EACCES")
    },
    complete: () => {
      completed = true
    },
  })
  expect(result).toEqual({ needsDirectory: true })
  expect(completed).toBe(false)
})

test("relative or empty paths are never used for filesystem writes", async () => {
  const writes: string[] = []
  expect(
    await completeFirstLaunch({
      pending: true,
      create: true,
      path: (name) => (name === "documents" ? "" : "relative"),
      mkdir: async (path) => {
        writes.push(path)
      },
      complete: () => {},
    }),
  ).toEqual({ needsDirectory: true })
  expect(writes).toEqual([])
})

test("explicit skip marks complete without resolving paths; restart is a no-op", async () => {
  let pending = true
  const input = {
    pending,
    create: false,
    path: () => {
      throw new Error("must not resolve")
    },
    mkdir: async () => {},
    complete: () => {
      pending = false
    },
  }
  expect(await completeFirstLaunch(input)).toBe(null)
  expect(pending).toBe(false)
  expect(await completeFirstLaunch({ ...input, pending, create: true })).toBe(null)
})

test("documents success never probes home", async () => {
  const paths: string[] = []
  expect(
    await completeFirstLaunch({
      pending: true,
      create: true,
      path: (name) => {
        paths.push(name)
        return "F:/documents"
      },
      mkdir: async () => {},
      complete: () => {},
    }),
  ).toEqual({ directory: join("F:/documents", "Default Project"), fallback: false })
  expect(paths).toEqual(["documents"])
})

test("completion storage errors do not create a second directory", async () => {
  const paths: string[] = []
  await expect(
    completeFirstLaunch({
      pending: true,
      create: true,
      path: (name) => {
        paths.push(name)
        return `F:/${name}`
      },
      mkdir: async () => {},
      complete: () => {
        throw new Error("store unavailable")
      },
    }),
  ).rejects.toThrow("store unavailable")
  expect(paths).toEqual(["documents"])
})
