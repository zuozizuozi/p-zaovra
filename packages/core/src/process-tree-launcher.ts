// A self-contained program for the embedded Bun runtime, not the application
// entrypoint. Command arguments and environment travel over the private IPC
// channel; the runtime asset contains only this fixed program.
export const source = String.raw`
const { spawn } = await import("node:child_process")
const { readFile, readdir } = await import("node:fs/promises")
const { constants } = await import("node:os")
const { dlopen, FFIType, ptr } = await import("bun:ffi")
if (!process.send) throw new Error("Tool owner requires its private IPC channel")
const send = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()))
let tool
let stopping
let admitted = false
let jobAdmitted = process.platform !== "win32"
let libc
const handles = new Map()
const boot = process.platform === "linux" ? (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() : undefined

async function identity(pid, includeExited = false) {
  const text = await readFile("/proc/" + pid + "/stat", "utf8").catch((error) => {
    if (error.code === "ENOENT" || error.code === "ESRCH") return
    throw error
  })
  if (!text) return
  const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/)
  if (!includeExited && (fields[0] === "Z" || fields[0] === "X")) return
  return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), birth: boot + ":" + fields[19], state: fields[0] }
}

function signal(item, name) {
  const fd = handles.get(item.pid)?.fd
  if (fd === undefined) throw new Error("Owned process has no pidfd")
  return Number(libc.symbols.syscall(424, fd, constants.signals[name], 0, 0)) === 0
}

async function waitStopped(item) {
  const end = Date.now() + 2000
  for (;;) {
    const current = await identity(item.pid)
    if (!current || current.birth !== item.birth || current.state === "T" || current.state === "t") return
    if (Date.now() >= end) throw new Error("Owned child did not stop before descendant traversal")
    await Bun.sleep(1)
  }
}

async function freeze(pid, refreeze) {
  const previous = handles.get(pid)
  if (previous && (await identity(pid))?.birth === previous.item.birth) {
    if (refreeze) { signal(previous.item, "SIGSTOP"); await waitStopped(previous.item) }
    return
  }
  const fd = Number(libc.symbols.syscall(434, pid, 0, 0, 0))
  if (fd < 0) {
    if (!await identity(pid)) return
    throw new Error("Cannot open owned pidfd; no numeric PID fallback")
  }
  let retained = false
  try {
    const item = await identity(pid, true)
    if (!item) return
    if (item.state === "Z" || item.state === "X") {
      if (item.ppid === process.pid && item.pid !== tool?.pid) libc.symbols.waitpid(item.pid, ptr(Buffer.alloc(4)), 1)
      return
    }
    if (handles.get(pid)?.item.birth === item.birth) return
    // Check after acquiring the stable kernel handle; a recycled PID is not
    // admitted merely because it appeared in an earlier children-file read.
    if (item.ppid !== process.pid) {
      const parent = handles.get(item.ppid)?.item
      if (!parent || (await identity(parent.pid))?.birth !== parent.birth) return
    }
    if (Number(libc.symbols.syscall(424, fd, constants.signals.SIGSTOP, 0, 0)) !== 0) {
      if (!await identity(pid)) return
      throw new Error("Cannot freeze owned child")
    }
    handles.set(pid, { fd, item })
    if (previous) libc.symbols.close(previous.fd)
    retained = true
    await waitStopped(item)
  } finally { if (!retained) libc.symbols.close(fd) }
}

async function children(pid) {
  const tasks = await readdir("/proc/" + pid + "/task").catch((error) => {
    if (error.code === "ENOENT" || error.code === "ESRCH") return []
    throw error
  })
  const found = new Set()
  for (const tid of tasks) {
    const text = await readFile("/proc/" + pid + "/task/" + tid + "/children", "utf8").catch((error) => {
      if (error.code === "ENOENT" || error.code === "ESRCH") return ""
      throw error
    })
    for (const item of text.trim().split(/\s+/).filter(Boolean)) found.add(Number(item))
  }
  return [...found]
}

async function cleanup(name = "SIGTERM", grace = 3000) {
  if (stopping) return stopping
  stopping = (async () => {
    if (process.platform === "win32") return
    const collect = async (refreeze = false) => {
      const deadline = Date.now() + 2000
      if (refreeze) for (const pid of handles.keys()) await freeze(pid, true)
      for (;;) {
        const before = handles.size
        for (const parent of [process.pid, ...handles.keys()]) {
          for (const pid of await children(parent)) await freeze(pid, false)
        }
        if (handles.size === before) return
        if (Date.now() > deadline) throw new Error("Owned descendant admission did not settle")
      }
    }
    // Only teardown visits children files. Frozen parents cannot fork while
    // their descendants are admitted; each helper owns its adopted orphans.
    await collect()
    const root = tool?.pid && handles.get(tool.pid)?.item
    if (root && root.pgid === root.pid && (await identity(root.pid))?.birth === root.birth) {
      try { process.kill(-root.pgid, name) }
      catch (error) { if (error.code !== "ESRCH") throw error }
    }
    for (const { item } of handles.values()) { signal(item, name); signal(item, "SIGCONT") }
    const end = Date.now() + grace
    for (;;) {
      const before = new Set(handles.keys())
      await collect()
      // A TERM handler may fork after the initial set resumes. Admit those
      // children too instead of declaring cleanup from a stale fixed list.
      for (const { item } of handles.values()) if (!before.has(item.pid)) { signal(item, name); signal(item, "SIGCONT") }
      const alive = []
      for (const { item } of handles.values()) {
        if ((await identity(item.pid))?.birth === item.birth) alive.push(item)
        // Never steal the main child's wait status from node:child_process.
        if (item.pid !== tool?.pid) libc.symbols.waitpid(item.pid, ptr(Buffer.alloc(4)), 1)
      }
      if (!alive.length && !(await children(process.pid)).length) return
      if (Date.now() >= end) break
      await Bun.sleep(10)
    }
    await collect(true)
    for (const { item } of handles.values()) signal(item, "SIGKILL")
    const killed = Date.now() + 2000
    for (;;) {
      let alive = false
      for (const { item } of handles.values()) {
        if ((await identity(item.pid))?.birth === item.birth) alive = true
        if (item.pid !== tool?.pid) libc.symbols.waitpid(item.pid, ptr(Buffer.alloc(4)), 1)
      }
      if (!alive) return
      if (Date.now() >= killed) throw new Error("Owned descendants did not terminate")
      await Bun.sleep(10)
    }
  })().finally(() => {
    for (const { fd, item } of handles.values()) {
      // A failed teardown must not leave an observed child frozen.
      signal(item, "SIGCONT")
      libc.symbols.close(fd)
    }
    handles.clear()
  })
  return stopping
}

async function finish(code, signalName) {
  try {
    await cleanup()
    await send({ kind: "exit", code, signal: signalName, cleanup: true })
    process.exit(code ?? (128 + (constants.signals[signalName] ?? 15)))
  } catch (error) {
    await send({ kind: "error", message: String(error?.stack ?? error) }).catch(() => {})
    process.exit(1)
  }
}

process.on("message", async (message) => {
  if (message?.kind === "admit" && process.platform === "win32" && !jobAdmitted) {
    const lib = dlopen("kernel32.dll", {
      OpenJobObjectW: { args: [FFIType.u32, FFIType.bool, FFIType.ptr], returns: FFIType.ptr },
      GetCurrentProcess: { args: [], returns: FFIType.ptr },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
      GetLastError: { args: [], returns: FFIType.u32 },
    })
    const label = Buffer.from(message.name + "\0", "utf16le")
    const job = lib.symbols.OpenJobObjectW(1, false, ptr(label))
    try {
      if (!job || !lib.symbols.AssignProcessToJobObject(job, lib.symbols.GetCurrentProcess()))
        throw new Error("Cannot join private tool Job: Windows " + lib.symbols.GetLastError())
      jobAdmitted = true
    } catch (error) {
      await send({kind:"error", message:String(error)})
      process.exitCode = 1
    } finally { if(job) lib.symbols.CloseHandle(job); lib.close() }
    if (!jobAdmitted) { process.exit(1); return }
    // The helper drops its borrowed Job handle before acknowledging. The
    // parent remains the only owner of KILL_ON_JOB_CLOSE, even after a crash.
    await send({kind:"admitted",pid:process.pid,birth})
    return
  }
  if (message?.kind === "abort") {
    await cleanup()
    await send({ kind: "exit", code: 1, signal: null, cleanup: true })
    process.exit(1)
  }
  if (message?.kind === "stop") {
    await cleanup(message.signal, message.grace).then(
      () => send({ kind: "stopped", cleanup: true }),
      (error) => send({ kind: "error", message: String(error?.stack ?? error) }),
    )
    return
  }
  if (admitted || !jobAdmitted || message?.kind !== "start") return
  admitted = true
  tool = spawn(message.command, message.args, {
    env: message.env, cwd: message.cwd, stdio: Array.from({ length: message.fds }, (_, i) => i),
    detached: process.platform === "linux" || message.detached,
    windowsHide: true, windowsVerbatimArguments: message.verbatim, shell: message.shell,
  })
  tool.once("error", (error) => {
    void send({ kind: "spawn-error", message: error.message, code: error.code, syscall: error.syscall, path: error.path, cleanup: true }).finally(() => process.exit(1))
  })
  tool.once("spawn", () => { void send({ kind: "started", pid: tool.pid }) })
  tool.once("exit", (code, signalName) => {
    void finish(code, signalName)
  })
})
process.on("disconnect", () => { void cleanup().finally(() => process.exit(1)) })
process.on("SIGTERM", () => { void cleanup().finally(() => process.exit(143)) })
process.on("SIGINT", () => { void cleanup("SIGINT").finally(() => process.exit(130)) })

let birth
if (process.platform === "linux") {
  const definitions = {
    prctl: { args: [FFIType.i32, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i32 },
    syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
    waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  }
  try { libc = dlopen("libc.so.6", definitions) } catch { libc = dlopen("libc.so", definitions) }
  if (libc.symbols.prctl(36, 1, 0, 0, 0) !== 0) throw new Error("Cannot establish tool subreaper")
  birth = (await identity(process.pid)).birth
} else {
  const lib = dlopen("kernel32.dll", {
    GetCurrentProcess: { args: [], returns: FFIType.ptr },
    GetProcessTimes: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  })
  const times = Array.from({ length: 4 }, () => Buffer.alloc(8))
  if (!lib.symbols.GetProcessTimes(lib.symbols.GetCurrentProcess(), ...times.map(value => ptr(value)))) throw new Error("Cannot read owner birth")
  birth = times[0].readBigUInt64LE().toString()
  lib.close()
}
await send({ kind: "ready", pid: process.pid, birth })
`
