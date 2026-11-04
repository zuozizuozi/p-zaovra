export * as ProcessTreeNative from "./process-tree.native.bun"

import { readFile, readdir } from "node:fs/promises"
import { constants } from "node:os"
import { PreviewNative } from "./preview-native.bun"

export type Identity = { pid: number; ppid: number; birth: string }
let bootID: Promise<string> | undefined

export async function identity(pid: number): Promise<Identity | undefined> {
  if (process.platform === "win32") {
    const birth = await PreviewNative.windowsProcess(pid, undefined, undefined, true)
    return birth ? { pid, ppid: 0, birth } : undefined
  }
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ESRCH") return
    throw error
  })
  if (!stat) return
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/)
  if (fields[0] === "Z" || fields[0] === "X") return
  if (!/^\d+$/.test(fields[19] ?? "")) throw new Error("Process creation identity is unavailable")
  const boot = await (bootID ??= readFile("/proc/sys/kernel/random/boot_id", "utf8").then((value) => value.trim()))
  return { pid, ppid: Number(fields[1]), birth: `${boot}:${fields[19]}` }
}

export async function snapshot(): Promise<Identity[]> {
  if (process.platform === "win32") return windowsSnapshot()
  const result: Identity[] = []
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue
    const item = await identity(Number(name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES" || error.code === "EPERM") return
      throw error
    })
    if (item) result.push(item)
  }
  return result
}

async function windowsSnapshot() {
  const { dlopen, FFIType, ptr } = await import("bun:ffi")
  const lib = dlopen("kernel32.dll", {
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
    Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
    WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
  })
  const handle = lib.symbols.CreateToolhelp32Snapshot(2, 0)
  const result: Identity[] = []
  try {
    if (!handle || Number(handle) === -1 || Number(handle) === 0xffffffffffffffff)
      throw new Error("Cannot enumerate owned process descendants")
    // PROCESSENTRY32W has one pointer-sized field; all supported Windows Bun targets are 64 bit.
    const entry = Buffer.alloc(568)
    const created = Buffer.alloc(8)
    const exited = Buffer.alloc(8)
    const kernel = Buffer.alloc(8)
    const user = Buffer.alloc(8)
    entry.writeUInt32LE(entry.length)
    if (!lib.symbols.Process32FirstW(handle, ptr(entry))) throw new Error("Process snapshot is unavailable")
    do {
      const pid = entry.readUInt32LE(8)
      if (!pid) continue
      const processHandle = lib.symbols.OpenProcess(0x101000, false, pid)
      if (!processHandle) continue
      try {
        if (lib.symbols.WaitForSingleObject(processHandle, 0) !== 258) continue
        if (!lib.symbols.GetProcessTimes(processHandle, ptr(created), ptr(exited), ptr(kernel), ptr(user))) continue
        result.push({ pid, ppid: entry.readUInt32LE(32), birth: created.readBigUInt64LE().toString() })
      } finally {
        lib.symbols.CloseHandle(processHandle)
      }
    } while (lib.symbols.Process32NextW(handle, ptr(entry)))
    return result
  } finally {
    if (handle && Number(handle) !== -1 && Number(handle) !== 0xffffffffffffffff) lib.symbols.CloseHandle(handle)
    lib.close()
  }
}

export async function signal(item: Identity, signal: NodeJS.Signals) {
  if (process.platform === "win32") {
    await PreviewNative.windowsProcess(item.pid, item.birth, undefined, true)
    return
  }
  const { dlopen, FFIType } = await import("bun:ffi")
  const symbols = {
    syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  } as const
  const lib = (() => {
    try {
      return dlopen("libc.so.6", symbols)
    } catch {
      return dlopen("libc.so", symbols)
    }
  })()
  const fd = Number(lib.symbols.syscall(434, item.pid, 0, 0, 0))
  try {
    if (fd < 0) {
      if ((await identity(item.pid))?.birth !== item.birth) return
      throw new Error(`Cannot acquire pidfd for owned process ${item.pid}; no PID fallback was used`)
    }
    if ((await identity(item.pid))?.birth !== item.birth) return
    if (Number(lib.symbols.syscall(424, fd, constants.signals[signal], 0, 0)) === 0) return
    if ((await identity(item.pid))?.birth !== item.birth) return
    throw new Error(`Could not signal owned process ${item.pid}`)
  } finally {
    if (fd >= 0) lib.symbols.close(fd)
    lib.close()
  }
}
