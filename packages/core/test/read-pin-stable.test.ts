import { expect, test } from "bun:test"
import { mkdir, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { ReadPin } from "../src/read-pin"
import { ReadPinNative } from "../src/read-pin-native.bun"
import { openStable } from "../src/read-pin-native.node"

const windows = process.platform === "win32" && process.arch === "x64" ? test : test.skip

async function fixture(body: (directory: string, file: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "stable-pin-"))
  try {
    await mkdir(path.join(directory, "parent"))
    const file = path.join(directory, "parent", "text.txt")
    await writeFile(file, "original")
    await body(directory, file)
  } finally {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("stable-pin-"))
      throw new Error("Unexpected stable pin fixture path")
    await rm(directory, { recursive: true, force: true })
  }
}

windows("stable pin denies writes, delete and parent rename but permits reads and sibling writes", () =>
  fixture(async (directory, file) => {
    const pin = (await ReadPinNative.openStable(file))!
    try {
      expect(await readFile(file, "utf8")).toBe("original")
      await expect(writeFile(file, "changed")).rejects.toThrow()
      await expect(unlink(file)).rejects.toThrow()
      await expect(rename(file, path.join(directory, "moved.txt"))).rejects.toThrow()
      await expect(rename(path.dirname(file), path.join(directory, "moved"))).rejects.toThrow()
      await writeFile(path.join(path.dirname(file), "sibling.txt"), "allowed")
      expect(Buffer.from(pin.read(32)).toString()).toBe("original")
      expect(pin.read(1)).toHaveLength(0)
    } finally {
      pin.close()
    }
    await writeFile(file, "after release")
    await rename(path.dirname(file), path.join(directory, "moved"))
  }),
)

windows("an existing writer refuses a stable pin and failure releases the parent chain", () =>
  fixture(async (directory, file) => {
    const writer = await open(file, "r+")
    try {
      await expect(ReadPinNative.openStable(file)).rejects.toThrow("NTSTATUS")
      await writer.write("changed!", 0)
    } finally {
      await writer.close()
    }
    await rename(path.dirname(file), path.join(directory, "moved"))
    const pin = (await ReadPinNative.openStable(path.join(directory, "moved", "text.txt")))!
    pin.close()
  }),
)

windows("a replacement during permission produces a different stable identity, never the old authorization", () =>
  fixture(async (directory, file) => {
    const original = (await ReadPinNative.open(file))!
    try {
      await rename(file, path.join(directory, "old.txt"))
      await writeFile(file, "replacement")
      const candidate = (await ReadPinNative.openStable(file))!
      try {
        expect(candidate.identity).not.toEqual(original.identity)
        // The caller must refuse this candidate before reading its bytes.
        expect(Buffer.from(original.read(32)).toString()).toBe("original")
      } finally {
        candidate.close()
      }
    } finally {
      original.close()
    }
  }),
)

windows("stable acquisition after approval matches the original and protects it through scoped cancellation", () =>
  fixture(async (_directory, file) => {
    const original = (await ReadPinNative.open(file))!
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ready = yield* Deferred.make<void>()
            const reader = yield* Effect.scoped(
              Effect.gen(function* () {
                const stable = yield* ReadPin.acquireStable(file)
                expect(stable?.identity).toEqual(original.identity)
                yield* Deferred.succeed(ready, undefined)
                yield* Effect.never
              }),
            ).pipe(Effect.forkChild)
            yield* Deferred.await(ready)
            yield* Effect.promise(async () => {
              await expect(writeFile(file, "blocked")).rejects.toThrow()
            })
            yield* Fiber.interrupt(reader)
          }),
        ),
      )
      await writeFile(file, "released")
    } finally {
      original.close()
    }
  }),
)

windows("stable pin rejects directory and unsupported path forms", () =>
  fixture(async (_directory, file) => {
    await expect(ReadPinNative.openStable(path.dirname(file))).rejects.toThrow("requires a file")
    for (const candidate of ["relative", "\\\\server\\share\\file", "C:\\file:stream", "C:\\file."])
      expect(await ReadPinNative.openStable(candidate)).toBeUndefined()
  }),
)

test("Node never claims stable native acquisition", async () => {
  expect(await openStable("C:\\file")).toBeUndefined()
})

windows("a writable mapping with its original file handle closed still refuses stable acquisition", () =>
  fixture(async (_directory, file) => {
    const { dlopen, FFIType, ptr } = await import("bun:ffi")
    const kernel = dlopen("kernel32.dll", {
      CreateFileW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.u64,
      },
      CreateFileMappingW: {
        args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.u64,
      },
      MapViewOfFile: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.ptr },
      UnmapViewOfFile: { args: [FFIType.ptr], returns: FFIType.bool },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
    })
    const name = Buffer.from(`${file}\0`, "utf16le")
    const handle = BigInt(kernel.symbols.CreateFileW(ptr(name), 0xc0000000, 7, null, 3, 0, null))
    expect(handle).not.toBe(0xffffffffffffffffn)
    const mapping = BigInt(kernel.symbols.CreateFileMappingW(handle, null, 4, 0, 0, null))
    expect(kernel.symbols.CloseHandle(handle)).toBe(true)
    try {
      expect(mapping).not.toBe(0n)
      const view = kernel.symbols.MapViewOfFile(mapping, 2, 0, 0, 0n)
      expect(view).toBeTruthy()
      try {
        await expect(ReadPinNative.openStable(file)).rejects.toThrow("NTSTATUS")
      } finally {
        if (view) expect(kernel.symbols.UnmapViewOfFile(view)).toBe(true)
      }
    } finally {
      if (mapping) expect(kernel.symbols.CloseHandle(mapping)).toBe(true)
      kernel.close()
    }
    const pin = (await ReadPinNative.openStable(file))!
    pin.close()
  }),
)

windows("POSIX replace cannot bypass the stable target's sharing restriction", () =>
  fixture(async (directory, file) => {
    const { dlopen, FFIType, ptr } = await import("bun:ffi")
    const kernel = dlopen("kernel32.dll", {
      CreateFileW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.u64,
      },
      SetFileInformationByHandle: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
    })
    const replacement = path.join(directory, "replacement.txt")
    await writeFile(replacement, "replacement")
    const source = Buffer.from(`${replacement}\0`, "utf16le")
    const handle = BigInt(kernel.symbols.CreateFileW(ptr(source), 0x110000, 7, null, 3, 0, null))
    const pin = (await ReadPinNative.openStable(file))!
    try {
      expect(handle).not.toBe(0xffffffffffffffffn)
      const target = Buffer.from(file, "utf16le")
      const info = Buffer.alloc(20 + target.length + 2)
      info.writeUInt32LE(3) // FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS
      info.writeUInt32LE(target.length, 16)
      target.copy(info, 20)
      expect(kernel.symbols.SetFileInformationByHandle(handle, 22, ptr(info), info.length)).toBe(false)
      expect(await readFile(file, "utf8")).toBe("original")
      pin.close()
      // Prove that the attempted native operation was supported and correctly formed.
      expect(kernel.symbols.SetFileInformationByHandle(handle, 22, ptr(info), info.length)).toBe(true)
      expect(await readFile(file, "utf8")).toBe("replacement")
    } finally {
      pin.close()
      expect(kernel.symbols.CloseHandle(handle)).toBe(true)
      kernel.close()
    }
  }),
)

windows("a reparse mutation cannot redirect a held parent chain", () =>
  fixture(async (directory, file) => {
    const { dlopen, FFIType, ptr } = await import("bun:ffi")
    const kernel = dlopen("kernel32.dll", {
      CreateFileW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.u64,
      },
      DeviceIoControl: {
        args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
      CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
    })
    const target = path.join(directory, "redirected")
    await mkdir(target)
    await writeFile(path.join(target, "text.txt"), "replacement")
    const substitute = Buffer.from(`\\??\\${target}`, "utf16le")
    const print = Buffer.from(target, "utf16le")
    const data = Buffer.alloc(16 + substitute.length + 2 + print.length + 2)
    data.writeUInt32LE(0xa0000003)
    data.writeUInt16LE(data.length - 8, 4)
    data.writeUInt16LE(substitute.length, 10)
    data.writeUInt16LE(substitute.length + 2, 12)
    data.writeUInt16LE(print.length, 14)
    substitute.copy(data, 16)
    print.copy(data, 18 + substitute.length)
    const redirect = () => {
      const name = Buffer.from(`${path.dirname(file)}\0`, "utf16le")
      const handle = BigInt(kernel.symbols.CreateFileW(ptr(name), 0x40000000, 7, null, 3, 0x02200000, null))
      if (handle === 0xffffffffffffffffn) return false
      try {
        const returned = Buffer.alloc(4)
        return kernel.symbols.DeviceIoControl(handle, 0x900a4, ptr(data), data.length, null, 0, ptr(returned), null)
      } finally {
        expect(kernel.symbols.CloseHandle(handle)).toBe(true)
      }
    }
    const pin = (await ReadPinNative.openStable(file))!
    try {
      expect(redirect()).toBe(false)
      expect(await readFile(file, "utf8")).toBe("original")
      pin.close()
      await unlink(file)
      // An empty parent after release is a positive control for the native buffer.
      expect(redirect()).toBe(true)
      expect(await readFile(file, "utf8")).toBe("replacement")
    } finally {
      pin.close()
      kernel.close()
    }
  }),
)
