export * as ReadPinNative from "./read-pin-native.bun"

import type { ReadPin } from "./read-pin"

/** Local, canonical drive paths only. Reparse traversal is refused at every component. */
export async function open(canonical: string): Promise<ReadPin.Pin | undefined> {
  if (process.platform !== "win32" || process.arch !== "x64") return
  if (!/^[a-z]:\\/i.test(canonical) || canonical.includes("\0")) return
  const components = canonical.slice(3).split("\\").filter(Boolean)
  if (components.some((part) => /[:/]/.test(part) || part === "." || part === ".." || /[. ]$/.test(part))) return
  const { dlopen, FFIType, ptr } = await import("bun:ffi")
  const kernel = dlopen("kernel32.dll", {
    CreateFileW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.u64,
    },
    GetFileInformationByHandleEx: { args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    GetFileType: { args: [FFIType.u64], returns: FFIType.u32 },
    GetDriveTypeW: { args: [FFIType.ptr], returns: FFIType.u32 },
    ReadFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    GetLastError: { args: [], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
  })
  const native = (() => {
    try {
      return dlopen("ntdll.dll", {
        NtCreateFile: {
          args: [
            FFIType.ptr,
            FFIType.u32,
            FFIType.ptr,
            FFIType.ptr,
            FFIType.ptr,
            FFIType.u32,
            FFIType.u32,
            FFIType.u32,
            FFIType.u32,
            FFIType.ptr,
            FFIType.u32,
          ],
          returns: FFIType.i32,
        },
      })
    } catch (error) {
      kernel.close()
      throw error
    }
  })()
  const handles: bigint[] = []
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    const failures = handles.toReversed().filter((handle) => !kernel.symbols.CloseHandle(handle))
    native.close()
    kernel.close()
    if (failures.length) throw new Error("Read pin could not close all owned handles")
  }
  const fail = (operation: string): never => {
    throw new Error(`${operation}: Win32 ${kernel.symbols.GetLastError()}`)
  }
  const attributes = (handle: bigint) => {
    const buffer = Buffer.alloc(8)
    if (!kernel.symbols.GetFileInformationByHandleEx(handle, 9, ptr(buffer), buffer.length)) fail("Read pin attributes")
    if (buffer.readUInt32LE() & 0x400) throw new Error("Read pin refuses reparse points")
    return buffer.readUInt32LE()
  }
  try {
    // This opens the drive root as the initial anchor, not an untrusted suffix.
    const root = Buffer.from(`\\\\?\\${canonical.slice(0, 3)}\0`, "utf16le")
    if (kernel.symbols.GetDriveTypeW(ptr(root)) !== 3) {
      close()
      return
    }
    const handle = BigInt(kernel.symbols.CreateFileW(ptr(root), 0x100081, 7, null, 3, 0x02200000, null))
    if (handle === 0n || handle === 0xffffffffffffffffn) fail("Read pin root")
    handles.push(handle)
    if (!(attributes(handle) & 0x10)) throw new Error("Read pin root is not a directory")
    for (const component of components) {
      const text = Buffer.from(`${component}\0`, "utf16le")
      if (text.length > 65534) throw new Error("Read pin component is too long")
      const name = Buffer.alloc(16)
      name.writeUInt16LE(text.length - 2)
      name.writeUInt16LE(text.length, 2)
      name.writeBigUInt64LE(BigInt(ptr(text)), 8)
      const object = Buffer.alloc(48)
      object.writeUInt32LE(48)
      object.writeBigUInt64LE(BigInt(handles.at(-1)!), 8)
      object.writeBigUInt64LE(BigInt(ptr(name)), 16)
      object.writeUInt32LE(0x40, 24)
      const result = Buffer.alloc(8)
      const statusBlock = Buffer.alloc(16)
      // Type-neutral: do not combine FILE_DIRECTORY_FILE with OPEN_REPARSE_POINT.
      const status = native.symbols.NtCreateFile(
        ptr(result),
        0x100081,
        ptr(object),
        ptr(statusBlock),
        null,
        0,
        7,
        1,
        0x00200020,
        null,
        0,
      )
      if (status < 0) throw new Error(`Read pin relative open: NTSTATUS ${(status >>> 0).toString(16)}`)
      const value = result.readBigUInt64LE()
      if (value === 0n) throw new Error("Read pin returned a null handle")
      handles.push(value)
      attributes(value)
    }
    const file = handles.at(-1)!
    if (kernel.symbols.GetFileType(file) !== 1) throw new Error("Read pin accepts disk objects only")
    const kind = attributes(file) & 0x10 ? "directory" : "file"
    const id = Buffer.alloc(24)
    const standard = Buffer.alloc(24)
    if (!kernel.symbols.GetFileInformationByHandleEx(file, 18, ptr(id), id.length)) fail("Read pin identity")
    if (!kernel.symbols.GetFileInformationByHandleEx(file, 1, ptr(standard), standard.length)) fail("Read pin size")
    return {
      identity: { volume: id.readBigUInt64LE().toString(), file: id.subarray(8, 24).toString("hex") },
      kind,
      size: standard.readBigInt64LE(8),
      read: (maximum) => {
        if (closed || kind !== "file") throw new Error("Read pin is closed or not a file")
        if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 65536) throw new Error("Invalid read pin bound")
        const data = Buffer.alloc(maximum)
        const count = Buffer.alloc(4)
        if (!kernel.symbols.ReadFile(file, ptr(data), maximum, ptr(count), null)) fail("Read pin read")
        return data.subarray(0, count.readUInt32LE())
      },
      entries: () => {
        if (closed || kind !== "directory") throw new Error("Read pin is closed or not a directory")
        const buffer = Buffer.alloc(65536)
        if (!kernel.symbols.GetFileInformationByHandleEx(file, 10, ptr(buffer), buffer.length)) {
          if (kernel.symbols.GetLastError() === 18) return []
          fail("Read pin directory")
        }
        const entries: { name: string; directory: boolean; reparse: boolean }[] = []
        let offset = 0
        while (true) {
          if (offset + 104 > buffer.length) throw new Error("Invalid native directory record")
          const next = buffer.readUInt32LE(offset)
          const length = buffer.readUInt32LE(offset + 60)
          const end = offset + 104 + length
          if (
            length % 2 ||
            end > buffer.length ||
            (next && (next % 8 || next < 104 + length || offset + next >= buffer.length))
          )
            throw new Error("Invalid native directory bounds")
          const name = buffer.toString("utf16le", offset + 104, end)
          const flags = buffer.readUInt32LE(offset + 56)
          if (name !== "." && name !== "..")
            entries.push({ name, directory: !!(flags & 0x10), reparse: !!(flags & 0x400) })
          if (!next) return entries
          offset += next
        }
      },
      close,
    }
  } catch (error) {
    close()
    throw error
  }
}
