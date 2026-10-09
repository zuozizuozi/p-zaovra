import { expect, test } from "bun:test"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { queueStoreWrite } from "./store-write-queue"

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`retries ${code} and preserves ordering of newer writes`, async () => {
    const root = await mkdtemp(join(tmpdir(), "store-retry-"))
    try {
      const file = join(root, "draft")
      await writeFile(file, "original")
      let attempts = 0
      const first = queueStoreWrite(file, async () => {
        await writeFile(file + ".tmp", "older")
        if (++attempts < 3) throw Object.assign(new Error("rename blocked"), { code })
        await rename(file + ".tmp", file)
      })
      const next = queueStoreWrite(file, async () => {
        expect(await readFile(file, "utf8")).toBe("older")
        await writeFile(file + ".tmp", "newer")
        await rename(file + ".tmp", file)
      })
      await Promise.all([first, next])
      expect(attempts).toBe(3)
      expect(await readFile(file, "utf8")).toBe("newer")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("exhausted retries preserve original data and do not poison later mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "store-exhausted-"))
  try {
    const file = join(root, "draft")
    await writeFile(file, "original")
    let attempts = 0
    await expect(
      queueStoreWrite(file, async () => {
        attempts++
        await writeFile(file + ".tmp", "uncommitted")
        throw Object.assign(new Error("rename blocked"), { code: "EPERM" })
      }),
    ).rejects.toThrow("rename blocked")
    expect(attempts).toBe(6)
    expect(await readFile(file, "utf8")).toBe("original")
    await queueStoreWrite(file, () => rm(file))
    expect(await Bun.file(file).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)

test("unrelated errors are not retried", async () => {
  let attempts = 0
  await expect(
    queueStoreWrite("unrelated", () => {
      attempts++
      throw Object.assign(new Error("full"), { code: "ENOSPC" })
    }),
  ).rejects.toThrow("full")
  expect(attempts).toBe(1)
})
