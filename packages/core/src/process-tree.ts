export * as ProcessTree from "./process-tree"

import type { ChildProcess, SpawnOptions } from "node:child_process"
import { spawn } from "node:child_process"
import { Duplex, PassThrough } from "node:stream"
import type { Readable, Writable } from "node:stream"
import { mkdtemp, writeFile } from "node:fs/promises"
import { unlinkSync, rmdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import launch from "cross-spawn"
import { ProcessTreeNative } from "#process-tree-native"
import { source } from "./process-tree-launcher"

const owners = new Set<Tracker>()
const pending = new Set<Promise<Launched>>()
const shutdownController = new AbortController()
export const shutdownSignal = shutdownController.signal
let closing: Promise<void> | undefined
let program: Promise<{ file: string; directory: string; config: string }> | undefined
export const supported = () => !!process.versions.bun && (process.platform === "win32" || process.platform === "linux")

type Result = readonly [number | null, NodeJS.Signals | null]
export type Output = { channel: "stdout" | "stderr"; data?: Buffer }
type Parsed = {
  command: string
  args: string[]
  options: SpawnOptions
  file?: string
  original: { command: string; args: string[] }
}
type Launched = { proc: ChildProcess; owner: Tracker; pid: number; closed: Promise<Result> }
type Message = {
  kind?: string
  pid?: number
  birth?: string
  code?: number | string | null
  signal?: NodeJS.Signals | null
  message?: string
  syscall?: string
  path?: string
  cleanup?: boolean
}
const parser = launch as typeof launch & {
  _parse(command: string, args: string[], options: SpawnOptions): Parsed
  _enoent: { verifyENOENT(code: number | null, parsed: Parsed): NodeJS.ErrnoException | undefined }
}

export class Tracker {
  pid = 0
  private stopping: Promise<void> | undefined
  constructor(
    readonly proc: ChildProcess,
    readonly stopOwned: (signal: NodeJS.Signals, grace: number) => Promise<void>,
    readonly all?: () => Readable,
  ) {}
  stop(signal: NodeJS.Signals = "SIGTERM", grace = 3000): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = this.stopOwned(signal, grace).then(() => {
      owners.delete(this)
    })
    return this.stopping
  }
}

export function assertOpen() {
  if (closing) throw new Error("Tool process admission is closed during CLI shutdown")
}

/** Tools cannot execute before their kernel owner acknowledges admission. */
export function start(command: string, args: readonly string[], options: SpawnOptions): Promise<Launched> {
  assertOpen()
  const starting = startOwned(command, args, options)
  pending.add(starting)
  void starting.then(
    () => pending.delete(starting),
    () => pending.delete(starting),
  )
  return starting
}

async function startOwned(command: string, args: readonly string[], options: SpawnOptions): Promise<Launched> {
  await ProcessTreeNative.installSubreaper()
  const parsed = parser._parse(command, [...args], options)
  if (!Array.isArray(parsed.options.stdio)) throw new Error("Owned process requires explicit descriptors")
  const descriptors = parsed.options.stdio
  const environment = parsed.options.env ?? process.env
  const helper = await (program ??= ownerProgram())
  const job = process.platform === "win32" ? await ProcessTreeNative.createJob() : undefined
  const proc = await Promise.resolve()
    .then(() =>
      spawn(process.execPath, ["--no-env-file", "--config=" + helper.config, helper.file], {
        cwd: helper.directory,
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          PATH: process.env.PATH,
          COMSPEC: process.env.COMSPEC,
          HOME: helper.directory,
          USERPROFILE: helper.directory,
          APPDATA: helper.directory,
          LOCALAPPDATA: helper.directory,
          TEMP: helper.directory,
          TMP: helper.directory,
          TMPDIR: helper.directory,
          BUN_BE_BUN: "1",
          BUN_OPTIONS: "",
          NODE_OPTIONS: "",
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
          DO_NOT_TRACK: "1",
        },
        stdio: [...descriptors, "ipc"],
        serialization: "json",
        detached: process.platform === "linux",
        windowsHide: true,
      }),
    )
    .catch(async (error) => {
      await job?.stop().catch((cleanup) => {
        throw new AggregateError([error, cleanup], "Tool owner startup and cleanup failed")
      })
      throw error
    })
  // Attach before sending start: Bun can close a short-lived child's pipe
  // before the Effect stream consumer subscribes after ownership admission.
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
    channel.on("end", () => {
      ended.add(channel)
      if (outputMode !== "split" && !merged.destroyed)
        queued.push({ channel: channel === proc.stdout ? "stdout" : "stderr" })
      pump()
    })
    channel.on("error", (error) => merged.destroy(error))
  }
  const buffers = proc.stdio.flatMap((stream, index) => {
    if (!stream || index === 0 || (descriptors[index] !== "pipe" && descriptors[index] !== "overlapped")) return []
    const buffered = new PassThrough()
    buffered.on("error", () => {})
    stream.on("error", (error) => buffered.destroy(error))
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
  let assigned = false
  let admissionPhase = "supervisor-start"
  let readyBirth: string | undefined
  let verifiedCleanup = false
  let result: Result | undefined
  let admissionDiagnostics = ""
  const diagnostics = (chunk: Buffer) => {
    admissionDiagnostics = (admissionDiagnostics + chunk.toString()).slice(-4096)
  }
  proc.stderr?.on("data", diagnostics)
  let rejectReady: (error: Error) => void
  let resolveReady: (pid: number) => void
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const processClosed = new Promise<Result>((resolve) => {
    proc.once("close", (code, signal) => resolve([code, signal]))
  })
  const owner = new Tracker(
    proc,
    async (signal, grace) => {
      if (job) {
        if (!assigned && proc.connected) proc.send({ kind: "abort" })
        await job.stop()
      } else if (proc.connected) {
        proc.send({ kind: "stop", signal, grace })
      }
      await deadline(lifecycleClosed, Math.max(0, grace) + 8000)
    },
    () => {
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
  )
  owners.add(owner)
  // Register close/error handlers before the child can publish its ready message.
  const lifecycleClosed = processClosed.then(async (exit): Promise<Result> => {
    if (job) await job.stop()
    if (!job && !verifiedCleanup) throw new Error("Tool subreaper exited without verified cleanup")
    owners.delete(owner)
    return result ?? exit
  })
  const closed = lifecycleClosed.then((status): Result => {
    const error = parser._enoent.verifyENOENT(status[0], parsed)
    if (error) throw error
    return status
  })
  void lifecycleClosed.catch(() => {})
  void closed.catch(() => {})
  proc.once("error", (error) => rejectReady(error))
  proc.once("exit", () => {
    // Killing the owned Job also closes descendants' inherited stdout handles,
    // so a root exit cannot leave the parent's close event waiting indefinitely.
    if (job) void job.stop().catch((error) => rejectReady(error))
  })
  proc.on("message", (input: unknown) => {
    if (!input || typeof input !== "object") return
    const message = input as Message
    if (message.kind === "ready" || message.kind === "admitted") {
      proc.stderr?.off("data", diagnostics)
      if (typeof message.pid !== "number" || message.pid !== proc.pid || typeof message.birth !== "string") {
        rejectReady(new Error("Tool owner identity mismatch"))
        return
      }
      if (job && message.kind === "ready") {
        admissionPhase = "job-admission"
        readyBirth = message.birth
        proc.send({ kind: "admit", name: job.name })
        return
      }
      try {
        if (job) {
          if (readyBirth !== message.birth) throw new Error("Tool owner birth changed during admission")
          job.verify(message.pid)
        }
        assigned = true
        admissionPhase = "command-start"
        assertOpen()
        proc.send({
          kind: "start",
          command: parsed.command,
          args: parsed.args,
          fds: descriptors.length,
          detached: parsed.options.detached,
          verbatim: parsed.options.windowsVerbatimArguments,
          shell: parsed.options.shell,
          cwd:
            parsed.options.cwd instanceof URL
              ? fileURLToPath(parsed.options.cwd)
              : (parsed.options.cwd ?? process.cwd()),
          env: environment,
        })
      } catch (error) {
        rejectReady(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    if (message.kind === "started" && Number.isSafeInteger(message.pid) && message.pid! > 0) {
      owner.pid = message.pid!
      resolveReady(message.pid!)
      return
    }
    if (message.cleanup === true) verifiedCleanup = true
    if (message.kind === "exit" && (message.code === null || typeof message.code === "number"))
      result = [message.code, message.signal ?? null]
    if (message.kind === "spawn-error" || message.kind === "error") {
      const error = Object.assign(new Error(message.message ?? "Tool owner failed"), {
        code: typeof message.code === "string" ? message.code : undefined,
        syscall: message.syscall,
        path: message.path,
      })
      rejectReady(error)
    }
  })
  const timer = setTimeout(
    () => rejectReady(new Error("Tool owner admission timed out during " + admissionPhase)),
    10000,
  )
  void processClosed.then(() => rejectReady(new Error("Tool owner exited before admission: " + admissionDiagnostics)))
  try {
    const pid = await ready
    return { proc: buffered, owner, pid, closed }
  } catch (error) {
    if (!assigned && proc.connected) proc.send({ kind: "abort" })
    await owner.stop().catch((cleanup) => {
      throw new AggregateError([error, cleanup], "Tool admission and cleanup failed")
    })
    for (const buffer of buffers) buffer.destroy()
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function ownerProgram() {
  // One fixed, non-secret runtime asset per parent. Its private directory is
  // also the helper HOME/cwd, so project .env/bunfig/preloads are never loaded.
  const directory = await mkdtemp(path.join(tmpdir(), "zaovra-tool-owner-"))
  const file = path.join(directory, "owner.mjs")
  const config = path.join(directory, "bunfig.toml")
  process.once("exit", () => {
    for (const item of [file, config]) {
      try {
        unlinkSync(item)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return
      }
    }
    try {
      rmdirSync(directory)
    } catch {
      /* never recursively remove a changed directory */
    }
  })
  await writeFile(file, source, { flag: "wx", mode: 0o600 })
  await writeFile(config, "env = false\n", { flag: "wx", mode: 0o600 })
  return { file, directory, config }
}

async function deadline<A>(promise: Promise<A>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Tool owner did not finish cleanup")), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function shutdown() {
  if (closing) return closing
  closing = Promise.resolve().then(async () => {
    shutdownController.abort(new Error("CLI is shutting down"))
    await Promise.allSettled([...pending])
    await Promise.all([...owners].map((owner) => owner.stop()))
  })
  return closing
}

export function installSignalHandlers() {
  if (!supported()) return () => {}
  const stop = (signal: NodeJS.Signals) => {
    void shutdown().then(
      () => process.exit(signal === "SIGINT" ? 130 : 143),
      (error) => {
        console.error("Tool process cleanup failed:", error)
        process.exit(1)
      },
    )
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
