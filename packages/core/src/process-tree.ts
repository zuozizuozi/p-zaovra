export * as ProcessTree from "./process-tree"

import type { ChildProcess } from "node:child_process"
import { scheduler } from "node:timers/promises"
import { ProcessTreeNative } from "#process-tree-native"

export type Identity = { pid: number; ppid: number; birth: string }

const owners = new Set<Tracker>()
const pending = new Set<Promise<Tracker | undefined>>()
const shutdownController = new AbortController()
export const shutdownSignal = shutdownController.signal
let timer: ReturnType<typeof setInterval> | undefined
let sampling: Promise<void> | undefined
let closing: Promise<void> | undefined
let samplingFailed = false

// The released CLI uses Bun. Node and macOS retain the existing spawner lifecycle;
// do not imply that a numeric-PID fallback provides stable-handle tree ownership.
export const supported = () => !!process.versions.bun && (process.platform === "win32" || process.platform === "linux")
const key = (item: Identity) => `${item.pid}:${item.birth}`

/** A current parent identity, rather than its recycled numeric PID, admits descendants. */
export function observe(known: Map<string, Identity>, snapshot: readonly Identity[]) {
  const current = new Map(snapshot.map((item) => [item.pid, item]))
  for (;;) {
    const before = known.size
    for (const child of snapshot) {
      const parent = current.get(child.ppid)
      if (!parent || !known.has(key(parent)) || known.has(key(child))) continue
      if (BigInt(child.birth.split(":").at(-1)!) < BigInt(parent.birth.split(":").at(-1)!)) continue
      known.set(key(child), child)
    }
    if (known.size === before) return
  }
}

async function sample() {
  if (sampling) return sampling
  sampling = ProcessTreeNative.snapshot().then((snapshot) => {
    for (const owner of owners) observe(owner.known, snapshot)
    samplingFailed = false
  })
  try {
    await sampling
  } finally {
    sampling = undefined
  }
}

export class Tracker {
  readonly known: Map<string, Identity>
  private stopping: Promise<void> | undefined

  constructor(root: Identity) {
    this.known = new Map([[key(root), root]])
  }

  async observe() {
    await sample()
    return [...this.known.values()]
  }

  stop(signal: NodeJS.Signals = "SIGTERM", grace = 3000): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = this.terminate(signal, grace)
    return this.stopping
  }

  private async terminate(signal: NodeJS.Signals, grace: number) {
    const frozen = new Map<string, Identity>()
    let complete = false
    try {
      await sample()
      if (process.platform === "linux") {
        // Freeze observed parents before the final scan so they cannot fork during teardown.
        for (;;) {
          const next = [...this.known.values()].filter((item) => !frozen.has(key(item)))
          if (next.length === 0) break
          for (const item of next) {
            await ProcessTreeNative.signal(item, "SIGSTOP")
            frozen.set(key(item), item)
          }
          await sample()
        }
      }
      const items = [...this.known.values()].reverse()
      for (const item of items) {
        await ProcessTreeNative.signal(item, signal)
        if (process.platform === "linux" && signal !== "SIGKILL") await ProcessTreeNative.signal(item, "SIGCONT")
      }
      const deadline = Date.now() + grace
      for (;;) {
        const alive = (await Promise.all(items.map((item) => ProcessTreeNative.identity(item.pid)))).filter(
          (item) => item && this.known.has(key(item)),
        )
        if (alive.length === 0) {
          complete = true
          return
        }
        if (Date.now() >= deadline) break
        await scheduler.wait(20)
      }
      for (const item of items) await ProcessTreeNative.signal(item, "SIGKILL")
      const killedDeadline = Date.now() + 2000
      for (;;) {
        const remaining = await Promise.all(items.map((item) => ProcessTreeNative.identity(item.pid)))
        if (!remaining.some((item) => item && this.known.has(key(item)))) {
          complete = true
          return
        }
        if (Date.now() >= killedDeadline) throw new Error("Owned tool processes did not terminate")
        await scheduler.wait(20)
      }
    } finally {
      // A failed scan or signal must not leave a partially frozen tool suspended.
      if (process.platform === "linux")
        await Promise.allSettled([...frozen.values()].map((item) => ProcessTreeNative.signal(item, "SIGCONT")))
      // A failed owner remains registered: a later CLI shutdown must report
      // that failure rather than silently treating a lost owner as clean.
      if (complete) owners.delete(this)
      if (owners.size === 0 && timer) {
        clearInterval(timer)
        timer = undefined
      }
    }
  }
}

export function assertOpen() {
  if (closing) throw new Error("Tool process admission is closed during CLI shutdown")
}

export function track(proc: ChildProcess): Promise<Tracker | undefined> {
  if (!supported()) return Promise.resolve(undefined)
  const registration = (async () => {
    if (!proc.pid) {
      await new Promise<void>((resolve, reject) => {
        proc.once("spawn", resolve)
        proc.once("error", reject)
      })
    }
    const root = await ProcessTreeNative.identity(proc.pid!)
    if (!root) return
    const owner = new Tracker(root)
    owners.add(owner)
    if (!timer) {
      timer = setInterval(
        () =>
          void sample().catch((error) => {
            if (!samplingFailed) console.error("Tool process observation failed:", error)
            samplingFailed = true
          }),
        50,
      )
      timer.unref()
    }
    await owner.observe()
    return owner
  })()
  pending.add(registration)
  void registration.then(
    () => pending.delete(registration),
    () => pending.delete(registration),
  )
  return registration
}

/** Task subprocesses only. Durable previews use their independent, explicit OS owner. */
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
  // Interactive TUI/runtime handlers own Ctrl+C while installed; their scope
  // disposal/normal CLI finally drains tools without forcing the UI to exit.
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
