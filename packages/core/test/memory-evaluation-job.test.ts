import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

const controller = path.resolve(import.meta.dir, "../../../script/evaluation/memory/windows-job.py")

async function owner(directory: string, script: string | string[], seconds = 20) {
  const python = Bun.which("python")
  if (!python) throw new Error("Windows evaluation tests require the host Python runtime")
  const child = Bun.spawn(
    [
      python,
      controller,
      "--cwd",
      directory,
      "--log",
      path.join(directory, "child.log"),
      "--seconds",
      String(seconds),
      "--",
      ...(typeof script === "string" ? [process.execPath, "-e", script] : script),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const errors = new Response(child.stderr).text()
  let buffer = ""
  async function read() {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (async () => {
          while (true) {
            const end = buffer.indexOf("\n")
            if (end !== -1) {
              const line = buffer.slice(0, end)
              buffer = buffer.slice(end + 1)
              return JSON.parse(line) as Record<string, unknown>
            }
            const next = await reader.read()
            if (next.done) throw new Error("controller-ended-before-reply")
            buffer += decoder.decode(next.value, { stream: true })
            if (buffer.length > 131072) throw new Error("controller-reply-too-large")
          }
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("controller-reply-timeout")), 5000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    child,
    read,
    async request(op: string, nonce: string) {
      child.stdin.write(JSON.stringify({ op, nonce }) + "\n")
      await child.stdin.flush()
      const reply = await read()
      expect(reply.nonce).toBe(nonce)
      return reply
    },
    async [Symbol.asyncDispose]() {
      child.stdin.end()
      child.kill()
      await child.exited
      await reader.cancel()
      expect(await errors).toBe("")
    },
  }
}

const descendant =
  'const child = Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"], {stdin:"ignore",stdout:"ignore",stderr:"ignore"}); console.log("child-ready:"+child.pid);'

test.skipIf(process.platform !== "win32")(
  "stdout backpressure cannot disable the independent process deadline",
  async () => {
    await using temp = await tmpdir()
    await using control = await owner(temp.path, descendant + "setInterval(()=>{},1000)", 1)
    expect((await control.read()).event).toBe("started")
    // Fill the bounded control-output pipe, then deliberately never consume another reply.
    control.child.stdin.write((JSON.stringify({ op: "inspect", nonce: "x".repeat(128) }) + "\n").repeat(5000))
    expect(await control.child.exited).toBe(124)
  },
  10000,
)

test.skipIf(process.platform !== "win32")(
  "native evaluation Job owns root and descendants before releasing execution",
  async () => {
    await using temp = await tmpdir()
    const outside = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      await using control = await owner(temp.path, descendant + "setInterval(()=>{},1000)")
      const start = await control.read()
      expect(start).toMatchObject({ event: "started", assignedBeforeResume: true, killOnClose: true })
      const deadline = Date.now() + 4000
      let inspection = await control.request("inspect", "first")
      while (Array.isArray(inspection.members) && inspection.members.length < 2 && Date.now() < deadline) {
        await Bun.sleep(20)
        inspection = await control.request("inspect", "ready")
      }
      expect(inspection.scope).toBe(start.scope)
      expect(inspection.rootAlive).toBe(true)
      expect(inspection.members).toContain(start.pid)
      expect(inspection.members).not.toContain(outside.pid)
      expect(Array.isArray(inspection.members) && inspection.members.length >= 2).toBe(true)
      const stopped = await control.request("stop", "stop")
      expect(stopped).toMatchObject({ event: "stopped", scope: start.scope, reason: "requested", remaining: [] })
      expect(await control.child.exited).toBe(0)
      expect(outside.exitCode).toBeNull()
    } finally {
      outside.kill()
      await outside.exited
    }
  },
  15000,
)

test.skipIf(process.platform !== "win32")(
  "a root exit cannot hide its still-owned descendant",
  async () => {
    await using temp = await tmpdir()
    const python = Bun.which("python")
    if (!python) throw new Error("Windows evaluation tests require Python")
    // Bun owns and closes its own children on exit. Python lets this descendant outlive its root.
    await using control = await owner(temp.path, [
      python,
      "-c",
      `import subprocess; subprocess.Popen([${JSON.stringify(process.execPath)}, '-e', 'setInterval(()=>{},1000)'])`,
    ])
    const start = await control.read()
    expect(start.event).toBe("started")
    const deadline = Date.now() + 4000
    let inspection = await control.request("inspect", "root")
    while (inspection.rootAlive === true && Date.now() < deadline) {
      await Bun.sleep(20)
      inspection = await control.request("inspect", "root")
    }
    expect(inspection.rootAlive).toBe(false)
    expect(inspection.members).not.toContain(start.pid)
    expect(Array.isArray(inspection.members) && inspection.members.length > 0).toBe(true)
    expect(await control.request("stop", "orphan-stop")).toMatchObject({ remaining: [], rootExit: 0 })
    expect(await control.child.exited).toBe(0)
  },
  15000,
)

test.skipIf(process.platform !== "win32")("closing control input terminates the entire owned Job", async () => {
  await using temp = await tmpdir()
  await using control = await owner(temp.path, "setInterval(()=>{},1000)")
  expect((await control.read()).event).toBe("started")
  control.child.stdin.end()
  expect(await control.read()).toMatchObject({ event: "stopped", reason: "control-closed", remaining: [] })
  expect(await control.child.exited).toBe(0)
})

test.skipIf(process.platform !== "win32")(
  "a real deadline terminates a live owned process instead of reporting completion",
  async () => {
    await using temp = await tmpdir()
    await using control = await owner(temp.path, "setInterval(()=>{},1000)", 1)
    expect((await control.read()).event).toBe("started")
    expect(await control.read()).toMatchObject({ event: "stopped", reason: "deadline", remaining: [], rootExit: 143 })
    expect(await control.child.exited).toBe(0)
  },
)
