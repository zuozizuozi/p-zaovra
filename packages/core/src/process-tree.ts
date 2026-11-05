export * as ProcessTree from "./process-tree"

import type { ChildProcess, SpawnOptions } from "node:child_process"
import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { Duplex, PassThrough } from "node:stream"
import type { Readable, Writable } from "node:stream"
import { scheduler } from "node:timers/promises"
import launch from "cross-spawn"

export type Child = ChildProcess
export type Output = { channel: "stdout" | "stderr"; data?: Buffer }
type Identity = { pid: number; ppid: number; pgid: number; birth: string; state?: string }
type Result = readonly [number | null, NodeJS.Signals | null]
const owners = new Set<Tracker>()
const executions = new Set<Promise<unknown>>()
const shutdownController = new AbortController()
export const shutdownSignal = shutdownController.signal
let closing: Promise<void> | undefined
let requestedSignal: "SIGINT" | "SIGTERM" | undefined
export const supported = () => ["win32", "linux", "darwin"].includes(process.platform)

export class Tracker {
  stopping: Promise<void> | undefined
  constructor(
    readonly proc: Child,
    readonly closed: Promise<Result>,
    readonly all: () => Readable,
  ) {}
  get pid() {
    return this.proc.pid!
  }
  stop(signal: NodeJS.Signals = "SIGTERM", grace = 1000): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = stopTree(this.proc, this.closed, signal, Math.max(0, grace)).then(() => {
      owners.delete(this)
    })
    return this.stopping
  }
}

export function assertOpen() {
  if (closing || shutdownSignal.aborted) throw new Error("Tool process admission is closed during CLI shutdown")
}

/** One direct spawn, with readers and shutdown ownership registered before yielding. Never replay on error. */
export function start(command: string, args: readonly string[], options: SpawnOptions) {
  assertOpen()
  const proc = launch(command, [...args], { ...options, detached: process.platform !== "win32" })
  const output = retainOutput(proc, Array.isArray(options.stdio) ? options.stdio : [])
  const closed = new Promise<Result>((resolve, reject) => {
    proc.once("close", (code, signal) => resolve([code, signal]))
    proc.once("error", reject)
  })
  void closed.catch(() => {})
  const owner = new Tracker(proc, closed, output.all)
  owners.add(owner)
  proc.once("close", () => {
    if (!owner.stopping) owners.delete(owner)
  })
  return new Promise<{ proc: Child; owner: Tracker; pid: number; closed: Promise<Result> }>((resolve, reject) => {
    proc.once("error", reject)
    proc.once("spawn", () => resolve({ proc: output.proc, owner, pid: proc.pid!, closed }))
  })
}

async function stopTree(proc: Child, closed: Promise<Result>, signal: NodeJS.Signals, grace: number) {
  // The ChildProcess object is the authority. Never rediscover an exited root by numeric PID.
  if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return
  if (process.platform === "win32") {
    await command("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"]).catch((error) => {
      if (proc.exitCode === null && proc.signalCode === null) throw error
    })
    await deadline(closed, 5000)
    return
  }
  const snapshot = await processes()
  const root = snapshot.find((item) => item.pid === proc.pid)
  if (!root) {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    throw new Error("Cannot observe running tool root; cleanup is unverified")
  }
  const descendants = new Set([root.pid])
  for (let previous = -1; previous !== descendants.size; ) {
    previous = descendants.size
    for (const item of snapshot) if (descendants.has(item.ppid)) descendants.add(item.pid)
  }
  const items = snapshot.filter((item) => descendants.has(item.pid))
  const send = async (next: NodeJS.Signals) => {
    // Only a still-observed member may authorize signaling this private group.
    const members = await Promise.all(items.map((item) => same(item)))
    const grouped = members.some((item) => item?.pgid === root.pid)
    if (grouped) signalPID(-root.pid, next)
    for (const item of members) if (item && (!grouped || item.pgid !== root.pid)) signalPID(item.pid, next)
  }
  await send(signal)
  if (signal !== "SIGKILL") {
    await scheduler.wait(grace)
    await send("SIGKILL")
  }
  await deadline(closed, 5000)
}

function command(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  )
}

async function stat(pid: number): Promise<Identity | undefined> {
  const text = await readFile("/proc/" + pid + "/stat", "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ESRCH") return undefined
    throw error
  })
  if (!text) return
  const fields = text.slice(text.lastIndexOf(") ") + 2).split(" ")
  if (fields.length < 20) throw new Error("Invalid process identity")
  return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), birth: fields[19], state: fields[0] }
}

function parsePS(text: string): Identity[] {
  return text
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 8) throw new Error("Invalid ps process identity")
      return {
        pid: Number(fields[0]),
        ppid: Number(fields[1]),
        pgid: Number(fields[2]),
        birth: fields.slice(3).join(" "),
      }
    })
}

async function processes(): Promise<Identity[]> {
  if (process.platform === "darwin") return parsePS(await command("ps", ["-axo", "pid=,ppid=,pgid=,lstart="]))
  return (
    await Promise.all((await readdir("/proc")).filter((name) => /^\d+$/.test(name)).map((pid) => stat(Number(pid))))
  ).filter((value): value is Identity => value !== undefined)
}

async function same(item: Identity) {
  const current =
    process.platform === "darwin"
      ? parsePS(
          await command("ps", ["-p", String(item.pid), "-o", "pid=,ppid=,pgid=,lstart="]).catch(
            (error: NodeJS.ErrnoException) => {
              if (Number(error.code) === 1) return ""
              throw error
            },
          ),
        )[0]
      : await stat(item.pid)
  if (current?.birth === item.birth && current.state !== "Z" && current.state !== "X") return current
}

function signalPID(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

async function deadline<A>(promise: Promise<A>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Tool cleanup did not finish; status unknown, do not replay")),
          milliseconds,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Wait for interrupted executor finalizers before the CLI exits. */
export function run<A>(execute: (signal: AbortSignal) => Promise<A>) {
  assertOpen()
  const task = execute(shutdownSignal)
  executions.add(task)
  void task.then(
    () => executions.delete(task),
    () => executions.delete(task),
  )
  return task
}

export function shutdown() {
  if (closing) return closing
  closing = Promise.resolve().then(async () => {
    shutdownController.abort(new Error("CLI is shutting down"))
    const results = await Promise.allSettled([...owners].map((owner) => owner.stop()))
    await Promise.allSettled([...executions])
    const errors = results.filter((value) => value.status === "rejected").map((value) => value.reason)
    if (errors.length) throw new AggregateError(errors, "Tool cleanup failed; status unknown, do not replay")
  })
  return closing
}

/** The top-level CLI exits only after its complete command and outer finalizers settle. */
export function signalExitCode() {
  if (!requestedSignal) return undefined
  return requestedSignal === "SIGINT" ? 130 : 143
}

export function installSignalHandlers() {
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    if (requestedSignal) return
    requestedSignal = signal
    // Only interrupt here. The top-level finally, outside run(), owns waiting and exit.
    shutdownController.abort(new Error("CLI received " + signal))
  }
  const interrupt = () => {
    if (process.listenerCount("SIGINT") === 1) stop("SIGINT")
  }
  const terminate = () => stop("SIGTERM")
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", terminate)
  return () => {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", terminate)
  }
}

function retainOutput(proc: Child, descriptors: readonly unknown[]) {
  // Attach synchronously after spawn: Bun can close a short-lived child's pipe
  // before the Effect stream consumer subscribes after launch.
  const retained = [...proc.stdio]
  const merged = new PassThrough({ objectMode: true })
  merged.on("error", () => {})
  const queued: Output[] = []
  const channels = [proc.stdout, proc.stderr].filter((value): value is NonNullable<typeof value> => value !== null)
  const ended = new Set<Readable>()
  let outputMode: "pending" | "split" | "all" = "pending"
  let blocked = false
  const pump = () => {
    if (outputMode !== "all" || blocked || merged.destroyed) return
    while (queued.length) {
      if (!merged.write(queued.shift()!)) {
        blocked = true
        for (const channel of channels) channel.pause()
        return
      }
    }
    if (ended.size === channels.length) {
      merged.end()
      return
    }
    for (const channel of channels) channel.resume()
  }
  merged.on("drain", () => {
    blocked = false
    pump()
  })
  merged.on("close", () => {
    if (outputMode !== "all") return
    queued.length = 0
    for (const channel of channels) channel.pause()
  })
  for (const channel of channels) {
    channel.on("data", (chunk: Buffer) => {
      if (outputMode === "split" || merged.destroyed) return
      queued.push({ channel: channel === proc.stdout ? "stdout" : "stderr", data: chunk })
      pump()
    })
    const finish = () => {
      if (ended.has(channel)) return
      ended.add(channel)
      if (outputMode !== "split" && !merged.destroyed)
        queued.push({ channel: channel === proc.stdout ? "stdout" : "stderr" })
      pump()
    }
    channel.on("end", finish)
    channel.on("close", finish)
    channel.on("error", (error) => merged.destroy(error))
  }
  const buffers = proc.stdio.flatMap((stream, index) => {
    if (!stream || index === 0 || (descriptors[index] !== "pipe" && descriptors[index] !== "overlapped")) return []
    const buffered = new PassThrough()
    buffered.on("error", () => {})
    stream.on("error", (error) => buffered.destroy(error))
    stream.on("close", () => buffered.end())
    ;(stream as Readable).pipe(buffered)
    const output = index > 2 ? Duplex.from({ readable: buffered, writable: stream as Writable }) : buffered
    retained[index] = output
    return [buffered]
  })
  // Keep Bun's original ChildProcess properties intact: its close handler may
  // destroy those streams. Consumers receive independent retained readers.
  const buffered = new Proxy(proc, {
    get(target, key) {
      if (key === "stdio") return retained
      if (key === "stdout" || key === "stderr") {
        if (outputMode === "pending") {
          outputMode = "split"
          queued.length = 0
          merged.end()
        }
        return retained[key === "stdout" ? 1 : 2]
      }
      const value = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return {
    proc: buffered,
    buffers,
    all: () => {
      if (outputMode === "pending") {
        outputMode = "all"
        // Preserve the observed cross-channel order before consumers attach.
        // Once the combined view is selected it alone applies backpressure.
        for (const [index, channel] of [proc.stdout, proc.stderr].entries()) {
          if (!channel) continue
          channel.pause()
          channel.unpipe(retained[index + 1] as Writable)
          const discarded = retained[index + 1] as PassThrough
          discarded.end()
          discarded.resume()
        }
        pump()
      }
      return merged
    },
  }
}
