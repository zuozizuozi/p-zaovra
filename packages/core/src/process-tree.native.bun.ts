export * as ProcessTreeNative from "./process-tree.native.bun"

import { readFile } from "node:fs/promises"
import { constants } from "node:os"
import { randomUUID } from "node:crypto"
import { PreviewNative } from "./preview-native.bun"

export type Identity = { pid: number; ppid: number; birth: string }
let bootID: Promise<string> | undefined

const windows = async () => {
  const { dlopen, FFIType, ptr } = await import("bun:ffi")
  const lib = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    QueryInformationJobObject: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.bool,
    },
    IsProcessInJob: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
    GetLastError: { args: [], returns: FFIType.u32 },
  })
  return { lib, ptr }
}
let windowsLibrary: ReturnType<typeof windows> | undefined

/** The parent alone owns this non-inheritable, kill-on-close kernel handle. */
export async function createJob() {
  const { lib, ptr } = await (windowsLibrary ??= windows())
  const name = "Local\\ZaovraTool-" + randomUUID()
  const label = Buffer.from(name + "\0", "utf16le")
  const handle = lib.symbols.CreateJobObjectW(null, ptr(label))
  if (!handle) throw new Error(`CreateJobObject failed: Windows ${lib.symbols.GetLastError()}`)
  const limits = Buffer.alloc(144)
  limits.writeUInt32LE(0x2000, 16)
  if (!lib.symbols.SetInformationJobObject(handle, 9, ptr(limits), limits.length)) {
    lib.symbols.CloseHandle(handle)
    throw new Error(`Cannot set KILL_ON_JOB_CLOSE: Windows ${lib.symbols.GetLastError()}`)
  }
  let closed = false
  let stopping: Promise<void> | undefined
  const members = () => {
    if (closed) return []
    const entries = Buffer.alloc(32776)
    if (!lib.symbols.QueryInformationJobObject(handle, 3, ptr(entries), entries.length, null))
      throw new Error(`Cannot inspect owned job membership: Windows ${lib.symbols.GetLastError()}`)
    const count = entries.readUInt32LE(4)
    return Array.from({ length: count }, (_, index) => Number(entries.readBigUInt64LE(8 + index * 8)))
  }
  return {
    name,
    members,
    verify(pid: number) {
      if (closed || !members().includes(pid))
        throw new Error("Tool supervisor is not a member of its private kernel Job")
    },
    stop(): Promise<void> {
      if (stopping) return stopping
      stopping = (async () => {
        if (closed) return
        const processes: import("bun:ffi").Pointer[] = []
        try {
          for (const pid of members()) {
            const processHandle = lib.symbols.OpenProcess(0x101000, false, pid)
            if (!processHandle) {
              if (lib.symbols.GetLastError() === 87) continue
              throw new Error("Cannot acquire owned member exit handle")
            }
            const member = Buffer.alloc(4)
            if (!lib.symbols.IsProcessInJob(processHandle, handle, ptr(member))) {
              lib.symbols.CloseHandle(processHandle)
              throw new Error("Cannot verify kernel Job membership")
            }
            if (!member.readUInt32LE()) {
              lib.symbols.CloseHandle(processHandle)
              continue
            }
            processes.push(processHandle)
          }
          if (!lib.symbols.TerminateJobObject(handle, 143))
            throw new Error(`TerminateJobObject failed: Windows ${lib.symbols.GetLastError()}`)
          const deadline = Date.now() + 5000
          for (;;) {
            const accounting = Buffer.alloc(48)
            if (!lib.symbols.QueryInformationJobObject(handle, 1, ptr(accounting), accounting.length, null))
              throw new Error(`Cannot verify job termination: Windows ${lib.symbols.GetLastError()}`)
            // Job accounting can become zero before a process HANDLE signals.
            // Retain and wait exact members as well; never substitute PID reuse
            // or an empty Job counter for actual process exit.
            const states = processes.map((item) => lib.symbols.WaitForSingleObject(item, 0))
            if (states.some((state) => state !== 0 && state !== 258)) throw new Error("Cannot verify owned member exit")
            if (accounting.readUInt32LE(40) === 0 && states.every((state) => state === 0)) break
            if (Date.now() >= deadline) throw new Error("Owned job still has active processes")
            await Bun.sleep(10)
          }
          if (!lib.symbols.CloseHandle(handle)) throw new Error("Cannot close owned job handle")
          closed = true
        } finally {
          for (const processHandle of processes) lib.symbols.CloseHandle(processHandle)
        }
      })()
      return stopping
    },
  }
}

let subreaper: Promise<void> | undefined
export function installSubreaper() {
  if (process.platform !== "linux") return Promise.resolve()
  return (subreaper ??= (async () => {
    const { dlopen, FFIType } = await import("bun:ffi")
    const definitions = {
      prctl: { args: [FFIType.i32, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i32 },
    } as const
    const lib = (() => {
      try {
        return dlopen("libc.so.6", definitions)
      } catch {
        return dlopen("libc.so", definitions)
      }
    })()
    try {
      if (lib.symbols.prctl(36, 1, 0, 0, 0) !== 0) throw new Error("Cannot establish CLI child subreaper")
    } finally {
      lib.close()
    }
  })())
}

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
