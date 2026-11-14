import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "./fixture/tmpdir"

for (const protocol of ["http", "git"]) {
  test(`service ready ${protocol} publishes only a complete document`, async () => {
    await using tmp = await tmpdir()
    const ready = path.join(tmp.path, "ready.json")
    const preload = path.join(tmp.path, "pause-write.ts")
    // This child-only interception holds the actual fixture write after creating
    // its destination. No production API or consumer is mocked or delayed.
    await Bun.write(
      preload,
      `
      const write = Bun.write
      Bun.write = async (file, data, options) => {
        await write(file, "", options)
        console.log(JSON.stringify({ file, value: JSON.parse(data) }))
        await new Response(Bun.stdin.stream()).text()
        return write(file, data, options)
      }
    `,
    )
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        path.join(import.meta.dir, "fixture/service-server.ts"),
        ready,
        protocol,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    let descendant: number | undefined
    try {
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let line = ""
      while (!line.includes("\n")) {
        const stage = await bounded(reader.read())
        if (stage.done) throw new Error("Fixture exited before the write handshake")
        line += decoder.decode(stage.value, { stream: true })
      }
      reader.releaseLock()
      const observed = JSON.parse(line) as {
        file: string
        value: { pid: number; childPid?: number; port: number }
      }
      descendant = observed.value.childPid
      expect(await Bun.file(observed.file).text()).toBe("")
      const visible = await Bun.file(ready).exists()
      console.log(JSON.stringify({ protocol, publishedBeforeWriteComplete: visible, stagedBytes: 0 }))
      if (visible) await expect(Bun.file(ready).json()).rejects.toThrow(SyntaxError)
      expect(visible).toBe(false)
      expect(path.dirname(observed.file)).toBe(path.dirname(ready))
      child.stdin.end()
      const deadline = Date.now() + 5000
      while (!(await Bun.file(ready).exists())) {
        if (Date.now() >= deadline) throw new Error("Ready document was not published")
        await Bun.sleep(10)
      }
      expect(await Bun.file(ready).json()).toEqual(observed.value)
      expect(await Bun.file(observed.file).exists()).toBe(false)
      if (protocol === "http") {
        expect(
          await fetch(`http://127.0.0.1:${observed.value.port}`, {
            signal: AbortSignal.timeout(2000),
          }).then((response) => response.text()),
        ).toBe("service-alive")
      }
      if (protocol === "git") {
        const probe = Bun.spawn(["git", "ls-remote", `git://127.0.0.1:${observed.value.port}/repo.git`], {
          stdout: "ignore",
          stderr: "pipe",
        })
        try {
          expect(await bounded(probe.exited)).toBe(0)
        } finally {
          probe.kill()
          await probe.exited
        }
      }
    } finally {
      child.stdin.end()
      await stop(child, descendant)
    }
  }, 15000)

  test(`service ready ${protocol} does not publish after startup failure`, async () => {
    await using tmp = await tmpdir()
    const ready = path.join(tmp.path, "ready.json")
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") })
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fixture/service-server.ts"), ready, protocol],
      {
        env: { ...process.env, ZAOVRA_FIXTURE_PORT: String(occupied.port) },
        stdout: "ignore",
        stderr: "pipe",
      },
    )
    try {
      expect(await bounded(child.exited)).not.toBe(0)
      expect(await new Response(child.stderr).text()).toContain("Failed to start server")
      expect(await fs.readdir(tmp.path)).toEqual([])
    } finally {
      await stop(child)
      occupied.stop(true)
    }
  }, 15000)
}

test("service ready git does not publish when repository initialization fails", async () => {
  await using tmp = await tmpdir()
  const ready = path.join(tmp.path, "ready.json")
  await Bun.write(path.join(tmp.path, "repo.git"), "not a directory")
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixture/service-server.ts"), ready, "git"], {
    stdout: "ignore",
    stderr: "pipe",
  })
  try {
    expect(await bounded(child.exited)).not.toBe(0)
    expect(await Bun.file(ready).exists()).toBe(false)
    expect(await fs.readdir(tmp.path)).toEqual(["repo.git"])
  } finally {
    await stop(child)
  }
}, 15000)

async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Fixture handshake timed out")), 5000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function stop(child: { pid: number; kill: () => void; exited: Promise<number> }, descendant?: number) {
  if (process.platform === "win32") {
    const kill = Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    await kill.exited
  }
  if (descendant && process.platform !== "win32") process.kill(descendant)
  child.kill()
  await child.exited
}
