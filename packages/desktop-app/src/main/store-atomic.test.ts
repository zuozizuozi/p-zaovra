import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeStoreAtomically } from "./store-atomic"
import { queueStoreWrite } from "./store-write-queue"

test("atomic queued writes preserve independent keys and leave no temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "store-atomic-"))
  try {
    const file = join(root, "draft")
    await writeFile(file, JSON.stringify({ first: "original" }))
    await Promise.all(
      ["first", "second"].map((key) =>
        queueStoreWrite(file, async () => {
          const data = JSON.parse(await readFile(file, "utf8"))
          await writeStoreAtomically(file, { ...data, [key]: "new" })
        }),
      ),
    )
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ first: "new", second: "new" })
    expect(await readdir(root)).toEqual(["draft"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("serialization failure preserves existing store contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "store-atomic-error-"))
  try {
    const file = join(root, "draft")
    await writeFile(file, '{"safe":true}')
    await expect(writeStoreAtomically(file, { unsupported: 1n })).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe('{"safe":true}')
    expect(await readdir(root)).toEqual(["draft"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
