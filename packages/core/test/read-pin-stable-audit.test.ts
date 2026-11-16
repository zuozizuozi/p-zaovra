import { expect, test } from "bun:test"
import { link, mkdir, mkdtemp, open, readFile, rename, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ReadPinNative } from "../src/read-pin-native.bun"

const windows = process.platform === "win32" && process.arch === "x64" ? test : test.skip
async function fixture(body: (directory: string, file: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "stable-audit-"))
  try {
    await mkdir(path.join(directory, "parent"))
    const file = path.join(directory, "parent", "source.txt")
    await writeFile(file, "original")
    await body(directory, file)
  } finally {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("stable-audit-"))
      throw new Error("Unexpected audit fixture path")
    await rm(directory, { recursive: true, force: true })
  }
}

windows("stable pin prevents new writers through an existing hard-link alias", () =>
  fixture(async (directory, file) => {
    const alias = path.join(directory, "alias.txt")
    await link(file, alias)
    const pin = (await ReadPinNative.openStable(file))!
    try {
      const other = (await ReadPinNative.open(alias))!
      try {
        expect(other.identity).toEqual(pin.identity)
      } finally {
        other.close()
      }
      await expect(writeFile(alias, "changed")).rejects.toThrow()
      expect(Buffer.from(pin.read(32)).toString()).toBe("original")
    } finally {
      pin.close()
    }
    await writeFile(alias, "after release")
    expect(await readFile(file, "utf8")).toBe("after release")
  }),
)

windows("an already-open hard-link writer prevents stable acquisition on another name", () =>
  fixture(async (directory, file) => {
    const alias = path.join(directory, "alias.txt")
    await link(file, alias)
    const writer = await open(alias, "r+")
    try {
      await expect(ReadPinNative.openStable(file)).rejects.toThrow("NTSTATUS")
    } finally {
      await writer.close()
    }
    await rename(path.dirname(file), path.join(directory, "moved"))
    const pin = (await ReadPinNative.openStable(path.join(directory, "moved", "source.txt")))!
    pin.close()
  }),
)

for (const parent of [false, true])
  windows(
    `existing DELETE handle on ${parent ? "parent" : "leaf"} refuses stable acquisition and releases partial handles`,
    () =>
      fixture(async (directory, file) => {
        const { dlopen, FFIType, ptr } = await import("bun:ffi")
        const kernel = dlopen("kernel32.dll", {
          CreateFileW: {
            args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
            returns: FFIType.u64,
          },
          CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
        })
        const name = Buffer.from(`${parent ? path.dirname(file) : file}\0`, "utf16le")
        const handle = BigInt(kernel.symbols.CreateFileW(ptr(name), 0x10000, 7, null, 3, 0x02200000, null))
        try {
          expect(handle).not.toBe(0xffffffffffffffffn)
          await expect(ReadPinNative.openStable(file)).rejects.toThrow("NTSTATUS")
        } finally {
          if (handle !== 0xffffffffffffffffn) expect(kernel.symbols.CloseHandle(handle)).toBe(true)
          kernel.close()
        }
        await rename(path.dirname(file), path.join(directory, "moved"))
        const pin = (await ReadPinNative.openStable(path.join(directory, "moved", "source.txt")))!
        pin.close()
      }),
  )

windows("stable sharing is not an immutable metadata snapshot; timestamp writes remain possible", () =>
  fixture(async (_directory, file) => {
    const pin = (await ReadPinNative.openStable(file))!
    try {
      const before = pin.snapshot()
      await utimes(file, new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"))
      const after = pin.snapshot()
      expect(after.written).not.toBe(before.written)
      expect(after.size).toBe(before.size)
      expect(Buffer.from(pin.read(32)).toString()).toBe("original")
    } finally {
      pin.close()
    }
    expect(() => pin.read(1)).toThrow("closed")
    expect(() => pin.snapshot()).toThrow("closed")
    pin.close()
    await writeFile(file, "after release")
  }),
)
