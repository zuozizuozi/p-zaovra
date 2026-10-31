export * as PreviewNative from "./preview-native.bun"

import { writeFile } from "node:fs/promises"

export async function windowsProcess(pid: number, stop?: string, cancelled?: string) {
  const { dlopen, FFIType, ptr } = await import("bun:ffi")
  const lib = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
    GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
  })
  const handle = lib.symbols.OpenProcess(0x101000 | (stop ? 1 : 0), false, pid)
  try {
    if (!handle || lib.symbols.WaitForSingleObject(handle, 0) !== 258) return
    const created = Buffer.alloc(8)
    const exited = Buffer.alloc(8)
    const kernel = Buffer.alloc(8)
    const user = Buffer.alloc(8)
    if (!lib.symbols.GetProcessTimes(handle, ptr(created), ptr(exited), ptr(kernel), ptr(user)))
      throw new Error("Cannot read preview creation identity; no process was signalled")
    const identity = created.readBigUInt64LE().toString()
    if (stop && identity === stop) {
      if (cancelled) await markCancelled(cancelled)
      if (!lib.symbols.TerminateProcess(handle, 143) || lib.symbols.WaitForSingleObject(handle, 5000) !== 0)
        throw new Error("Owned preview cancellation did not complete")
    }
    return identity
  } finally {
    if (handle) lib.symbols.CloseHandle(handle)
    lib.close()
  }
}

export async function launchWindows(
  line: string,
  directory: string,
  env?: NodeJS.ProcessEnv,
  _admission?: { file: string; timeout: number },
): Promise<{ pid: number; admittedBirth?: string }> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi")
  const lib = dlopen("kernel32.dll", {
    CreateProcessW: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.bool,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.bool,
    },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
    GetLastError: { args: [], returns: FFIType.u32 },
  })
  const startup = Buffer.alloc(104)
  startup.writeUInt32LE(104)
  startup.writeUInt32LE(1, 60)
  const processInfo = Buffer.alloc(24)
  const command = Buffer.from(line + "\0", "utf16le")
  const cwd = Buffer.from(directory + "\0", "utf16le")
  const environment = env
    ? Buffer.from(
        Object.entries(env)
          .filter((entry) => entry[1] !== undefined)
          .sort((a, b) => a[0].toUpperCase().localeCompare(b[0].toUpperCase()))
          .map(([key, value]) => `${key}=${value}`)
          .join("\0") + "\0\0",
        "utf16le",
      )
    : undefined
  try {
    // BREAKAWAY_FROM_JOB must succeed; never claim survival inside the CLI Job.
    if (
      !lib.symbols.CreateProcessW(
        null,
        ptr(command),
        null,
        null,
        false,
        0x1000410,
        environment ? ptr(environment) : null,
        ptr(cwd),
        ptr(startup),
        ptr(processInfo),
      )
    )
      throw new Error(`Cannot launch independent preview supervisor: Windows ${lib.symbols.GetLastError()}`)
    return { pid: processInfo.readUInt32LE(16) }
  } finally {
    for (const offset of [0, 8]) {
      const handle = Number(processInfo.readBigUInt64LE(offset))
      if (handle) lib.symbols.CloseHandle(handle as import("bun:ffi").Pointer)
    }
    lib.close()
  }
}

export async function cancelLinux(
  pid: number,
  expected: string,
  _request: string,
  verify: () => Promise<string | undefined>,
  cancelled: string,
) {
  const { dlopen, FFIType } = await import("bun:ffi")
  const libc = dlopen("libc.so.6", {
    syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  })
  const fd = Number(libc.symbols.syscall(434, pid, 0, 0, 0))
  try {
    if (fd < 0) throw new Error("Cannot acquire pidfd; preview was not signalled")
    if ((await verify()) !== expected) return false
    await markCancelled(cancelled)
    if (Number(libc.symbols.syscall(424, fd, 15, 0, 0)) !== 0) throw new Error("Preview signal failed")
    return true
  } finally {
    if (fd >= 0) libc.symbols.close(fd)
    libc.close()
  }
}

async function markCancelled(file: string) {
  await writeFile(file, "cancelled", { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
}
