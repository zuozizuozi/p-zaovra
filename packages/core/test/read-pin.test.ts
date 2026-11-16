import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { ReadPin } from "../src/read-pin"
import { ReadPinNative } from "../src/read-pin-native.bun"
import { open } from "../src/read-pin-native.node"

const windows = process.platform === "win32" && process.arch === "x64" ? test : test.skip

async function fixture(body: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "read-pin-"))
  try {
    await body(directory)
  } finally {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("read-pin-"))
      throw new Error("Unexpected fixture cleanup path")
    await rm(directory, { recursive: true, force: true })
  }
}

windows("native pin reads original object after replacement and deletion", () =>
  fixture(async (directory) => {
    const file = path.join(directory, "original.txt")
    await writeFile(file, "original")
    const pin = (await ReadPinNative.open(file))!
    try {
      expect(pin.kind).toBe("file")
      expect(pin.size).toBe(8n)
      expect(pin.identity.volume).toMatch(/^\d+$/)
      expect(pin.identity.file).toMatch(/^[0-9a-f]{32}$/)
      await rename(file, path.join(directory, "old.txt"))
      await writeFile(file, "replacement")
      await unlink(path.join(directory, "old.txt"))
      expect(Buffer.from(pin.read(4)).toString()).toBe("orig")
      expect(Buffer.from(pin.read(32)).toString()).toBe("inal")
      expect(pin.read(1)).toHaveLength(0)
      expect(() => pin.read(65537)).toThrow("bound")
    } finally {
      pin.close()
    }
    pin.close()
    expect(() => pin.read(1)).toThrow("closed")
  }),
)

windows("directory enumeration stays on the held directory after rename", () =>
  fixture(async (directory) => {
    const original = path.join(directory, "parent")
    await mkdir(original)
    await writeFile(path.join(original, "before.txt"), "before")
    const pin = (await ReadPinNative.open(original))!
    try {
      await rename(original, path.join(directory, "moved"))
      await mkdir(original)
      await writeFile(path.join(original, "after.txt"), "after")
      expect(pin.kind).toBe("directory")
      expect(pin.entries()).toEqual([{ name: "before.txt", directory: false, reparse: false }])
      expect(pin.entries()).toEqual([])
    } finally {
      pin.close()
    }
  }),
)

windows("reparse leaves and ancestors are refused, not traversed", () =>
  fixture(async (directory) => {
    const outside = path.join(directory, "outside")
    const link = path.join(directory, "link")
    await mkdir(outside)
    await writeFile(path.join(outside, "secret.txt"), "secret")
    await symlink(outside, link, "junction")
    await expect(ReadPinNative.open(link)).rejects.toThrow("reparse")
    await expect(ReadPinNative.open(path.join(link, "secret.txt"))).rejects.toThrow("reparse")
    // Failed acquisition released the chain, including the reparse leaf.
    await unlink(link)
  }),
)

windows("scoped cancellation while awaiting permission releases the native pin", () =>
  fixture(async (directory) => {
    const file = path.join(directory, "text.txt")
    await writeFile(file, "not read before approval")
    let captured: ReadPin.Pin | undefined
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const acquired = yield* Deferred.make<void>()
          const reader = yield* Effect.scoped(
            Effect.gen(function* () {
              captured = yield* ReadPin.acquire(file)
              yield* Deferred.succeed(acquired, undefined)
              yield* Effect.never
            }),
          ).pipe(Effect.forkChild)
          yield* Deferred.await(acquired)
          yield* Fiber.interrupt(reader)
        }),
      ),
    )
    expect(captured).toBeDefined()
    expect(() => captured!.read(1)).toThrow("closed")
  }),
)

windows("unsupported path forms never open a native target", async () => {
  for (const file of ["relative", "\\\\server\\share\\file", "C:\\x:stream", "C:\\..\\file", "C:\\file."])
    expect(await ReadPinNative.open(file)).toBeUndefined()
})

test("Node adapter explicitly reports unsupported", async () => {
  expect(await open("C:\\file")).toBeUndefined()
})

windows("successful and failed acquisitions do not retain Windows handles", () =>
  fixture(async (directory) => {
    const { dlopen, FFIType, ptr } = await import("bun:ffi")
    const kernel = dlopen("kernel32.dll", {
      GetCurrentProcess: { args: [], returns: FFIType.u64 },
      GetProcessHandleCount: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.bool },
    })
    try {
      const file = path.join(directory, "file.txt")
      await writeFile(file, "file")
      const warm = (await ReadPinNative.open(file))!
      warm.close()
      const before = Buffer.alloc(4)
      const after = Buffer.alloc(4)
      expect(kernel.symbols.GetProcessHandleCount(kernel.symbols.GetCurrentProcess(), ptr(before))).toBe(true)
      for (let count = 0; count < 20; count++) {
        const pin = (await ReadPinNative.open(file))!
        pin.close()
        await expect(ReadPinNative.open(path.join(directory, "missing", "file.txt"))).rejects.toThrow("NTSTATUS")
      }
      expect(kernel.symbols.GetProcessHandleCount(kernel.symbols.GetCurrentProcess(), ptr(after))).toBe(true)
      expect(after.readUInt32LE()).toBe(before.readUInt32LE())
    } finally {
      kernel.close()
    }
  }),
)

windows("bounded native reads preserve binary media bytes", () =>
  fixture(async (directory) => {
    const file = path.join(directory, "image.png")
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128])
    await writeFile(file, bytes)
    const pin = (await ReadPinNative.open(file))!
    try {
      expect(Buffer.from(pin.read(65536))).toEqual(bytes)
    } finally {
      pin.close()
    }
  }),
)

windows("native directory batches retain long Unicode names across buffer boundaries", () =>
  fixture(async (directory) => {
    const names = Array.from({ length: 320 }, (_, index) => `${index}-${"目录".repeat(65)}.txt`)
    for (const name of names) await writeFile(path.join(directory, name), "")
    const pin = (await ReadPinNative.open(directory))!
    try {
      const seen: string[] = []
      for (let page = 0; page < 20; page++) {
        const entries = pin.entries()
        if (!entries.length) break
        seen.push(...entries.map((entry) => entry.name))
      }
      expect(seen.toSorted()).toEqual(names.toSorted())
    } finally {
      pin.close()
    }
  }),
)
