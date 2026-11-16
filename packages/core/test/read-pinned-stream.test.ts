import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ReadPinNative } from "../src/read-pin-native.bun"
import { ReadToolFileSystem } from "../src/tool/read-filesystem"

const windows = process.platform === "win32" && process.arch === "x64" ? test : test.skip

async function fixture(body: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "read-pinned-stream-"))
  try {
    await body(directory)
  } finally {
    if (
      path.dirname(directory) !== path.resolve(tmpdir()) ||
      !path.basename(directory).startsWith("read-pinned-stream-")
    )
      throw new Error("Unexpected fixture cleanup path")
    await rm(directory, { recursive: true, force: true })
  }
}

windows("pinned stream hashes original bytes once after the path is replaced", () =>
  fixture(async (directory) => {
    const file = path.join(directory, "text.txt")
    const bytes = Buffer.from("\ufeff原始内容\n" + "boundary".repeat(1200))
    await writeFile(file, bytes)
    const pin = (await ReadPinNative.open(file))!
    try {
      await rename(file, path.join(directory, "held.txt"))
      await writeFile(file, "replacement must not be read")
      const observations: { digest: string; bytes: number; text: string }[] = []
      let delivered = 0
      let eof = 0
      const result = await Effect.runPromise(
        ReadToolFileSystem.readPinned(
          {
            ...pin,
            read: (size) => {
              const chunk = pin.read(size)
              delivered += chunk.length
              if (!chunk.length) eof++
              return chunk
            },
          },
          file,
          "text.txt",
          {},
          (value) => {
            observations.push(value)
          },
        ),
      )
      expect(result.content).toBe(bytes.toString("utf8").slice(1))
      expect(delivered).toBe(bytes.length)
      expect(eof).toBe(1)
      expect(observations).toHaveLength(1)
      expect(observations[0]).toMatchObject({
        digest: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        text: result.content,
      })
    } finally {
      pin.close()
    }
  }),
)

windows("explicit pagination never stages a complete-file observation", () =>
  fixture(async (directory) => {
    const file = path.join(directory, "text.txt")
    await writeFile(file, "first\nsecond\n")
    const pin = (await ReadPinNative.open(file))!
    try {
      let observations = 0
      const result = await Effect.runPromise(
        ReadToolFileSystem.readPinned(pin, file, "text.txt", { limit: 1 }, () => {
          observations++
        }),
      )
      expect(result.content).toBe("first")
      expect(observations).toBe(0)
    } finally {
      pin.close()
    }
  }),
)

windows("a changed native metadata observation suppresses the receipt without losing output", () =>
  fixture(async (directory) => {
    const file = path.join(directory, "text.txt")
    await writeFile(file, "original")
    const pin = (await ReadPinNative.open(file))!
    try {
      let snapshots = 0
      let observations = 0
      const result = await Effect.runPromise(
        ReadToolFileSystem.readPinned(
          {
            ...pin,
            // Deterministically exercise the after-read metadata rejection. Actual
            // object retention and bytes still use the real Windows handle.
            snapshot: () => {
              const value = pin.snapshot()
              return { ...value, changed: value.changed + BigInt(snapshots++) }
            },
          },
          file,
          "text.txt",
          {},
          () => {
            observations++
          },
        ),
      )
      expect(result.content).toBe("original")
      expect(snapshots).toBe(2)
      expect(observations).toBe(0)
    } finally {
      pin.close()
    }
  }),
)

windows("a stream read failure cannot stage the partial text", () =>
  fixture(async (directory) => {
    const file = path.join(directory, "text.txt")
    await writeFile(file, "original")
    const pin = (await ReadPinNative.open(file))!
    try {
      let reads = 0
      let observations = 0
      const exit = await Effect.runPromiseExit(
        ReadToolFileSystem.readPinned(
          {
            ...pin,
            read: (size) => {
              if (reads++) throw new Error("injected read failure after the first chunk")
              return pin.read(size)
            },
          },
          file,
          "text.txt",
          {},
          () => {
            observations++
          },
        ),
      )
      expect(exit._tag).toBe("Failure")
      expect(observations).toBe(0)
    } finally {
      pin.close()
    }
  }),
)
