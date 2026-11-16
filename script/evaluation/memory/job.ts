/// <reference lib="dom.asynciterable" />
import path from "node:path"
import { randomUUID } from "node:crypto"

/** Evaluation host only. Run beneath the outer resource/profile supervisor. */
export async function openJob(input: { directory: string; log: string; command: string[]; seconds?: number }) {
  if (process.platform !== "win32") throw new Error("evaluation-job-requires-windows")
  const python = Bun.which("python")
  const seconds = input.seconds ?? 900
  if (
    !python ||
    !path.isAbsolute(input.directory) ||
    !path.isAbsolute(input.log) ||
    !input.command.length ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 3600
  )
    throw new Error("invalid-evaluation-launch")
  const child = Bun.spawn(
    [
      python,
      path.join(import.meta.dir, "windows-job.py"),
      "--cwd",
      input.directory,
      "--log",
      input.log,
      "--seconds",
      String(seconds),
      "--",
      ...input.command,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const messages: Record<string, unknown>[] = []
  let failure: Error | undefined
  let ended = false
  let busy = false
  let closed = false
  let waiter: { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void } | undefined
  const fail = () => {
    failure ??= new Error("evaluation-control-failed")
    waiter?.reject(failure)
    waiter = undefined
    if (child.exitCode === null) child.kill()
  }
  // Always drain both pipes. Child output goes to its separate log, never this control stream.
  const output = (async () => {
    let buffer = ""
    const decoder = new TextDecoder("utf-8", { fatal: true })
    for await (const bytes of child.stdout) {
      buffer += decoder.decode(bytes, { stream: true })
      if (buffer.length > 131072) throw new Error("control-limit")
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n")
        const value: unknown = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-control")
        const message = value as Record<string, unknown>
        if (message.event === "failed") throw new Error("native-control-failed")
        if (waiter) {
          const ready = waiter
          waiter = undefined
          ready.resolve(message)
        } else {
          if (messages.length >= 2) throw new Error("unsolicited-control-overflow")
          messages.push(message)
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) throw new Error("truncated-control")
    ended = true
    if (waiter) fail()
  })().catch(fail)
  const errors = (async () => {
    for await (const bytes of child.stderr) {
      // Do not retain or echo arbitrary exception/argument text.
      if (bytes.byteLength) fail()
    }
  })().catch(fail)

  async function next() {
    if (failure) throw failure
    const queued = messages.shift()
    if (queued) return queued
    if (ended || waiter) throw new Error("evaluation-control-unavailable")
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        waiter = { resolve, reject }
        timer = setTimeout(() => {
          fail()
        }, 10000)
      })
    } finally {
      clearTimeout(timer)
      waiter = undefined
    }
  }
  async function close() {
    closed = true
    child.stdin.end()
    if (child.exitCode === null) child.kill()
    await child.exited
    await Promise.all([output, errors])
  }
  const start = await next().catch(async () => {
    await close()
    throw new Error("evaluation-job-start-failed")
  })
  if (
    start.event !== "started" ||
    typeof start.scope !== "string" ||
    !/^[a-f0-9-]{36}$/.test(start.scope) ||
    !integer(start.pid) ||
    start.assignedBeforeResume !== true ||
    start.killOnClose !== true
  ) {
    await close()
    throw new Error("evaluation-job-start-invalid")
  }
  const scope = start.scope
  const pid = start.pid
  async function request(op: "inspect" | "stop") {
    if (busy || closed || failure) throw new Error("evaluation-job-not-available")
    busy = true
    try {
      const nonce = randomUUID()
      child.stdin.write(JSON.stringify({ op, nonce }) + "\n")
      await child.stdin.flush()
      const message = await next()
      if (message.scope !== scope || message.nonce !== nonce) throw new Error("control-identity-conflict")
      return message
    } catch {
      await close()
      throw new Error("evaluation-job-request-failed")
    } finally {
      busy = false
    }
  }
  return Object.freeze({
    scope,
    pid,
    async inspect() {
      const message = await request("inspect")
      if (
        message.event !== "inspection" ||
        message.pid !== pid ||
        typeof message.rootAlive !== "boolean" ||
        !Array.isArray(message.members) ||
        !message.members.every((value) => integer(value))
      ) {
        await close()
        throw new Error("evaluation-job-inspection-invalid")
      }
      return { scope, pid, rootAlive: message.rootAlive, members: message.members as number[] }
    },
    async stop() {
      const message = await request("stop")
      closed = true
      if (
        message.event !== "stopped" ||
        message.reason !== "requested" ||
        !Array.isArray(message.remaining) ||
        message.remaining.length !== 0 ||
        !integer(message.rootExit, 0)
      ) {
        await close()
        throw new Error("evaluation-job-stop-unconfirmed")
      }
      const exit = await child.exited
      await Promise.all([output, errors])
      if (exit !== 0 || failure || messages.length) throw new Error("evaluation-job-stop-unconfirmed")
      // Process cleanup only. This must never turn an unfinished Session into a completed one.
      return { scope, pid, remaining: [] as number[], rootExit: message.rootExit, controllerExit: 0 as const }
    },
    [Symbol.asyncDispose]: close,
  })
}

function integer(value: unknown, minimum = 1): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
}
