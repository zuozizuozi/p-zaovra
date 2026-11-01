import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"
import { LSPClient } from "../src/lsp/client"
import { tmpdir } from "./fixture/tmpdir"

test("490 initialization cancellation disposes the pending handshake before its OS owner closes", async () => {
  await using tmp = await tmpdir()
  const ready = path.join(tmp.path, "ready")
  const child = spawn(
    process.execPath,
    [
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready');process.stdin.resume();setInterval(()=>{},1000)`,
    ],
    { stdio: "pipe", windowsHide: true },
  )
  const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const abort = new AbortController()
  const created = LSPClient.create({
    serverID: "cancel-init",
    server: { process: child },
    root: tmp.path,
    directory: tmp.path,
    signal: abort.signal,
    runtime: { normalizePath: (file) => file, readText: async () => "", stop: async () => {} },
  }).then(
    () => "initialized",
    () => "aborted",
  )
  try {
    const deadline = Date.now() + 2000
    while (!(await Bun.file(ready).exists()) && Date.now() < deadline) await Bun.sleep(5)
    expect(await Bun.file(ready).text()).toBe("ready")
    abort.abort()
    expect(await Promise.race([created, Bun.sleep(300).then(() => "not-cancelled")])).toBe("aborted")
    expect(child.exitCode).toBeNull()
  } finally {
    child.kill()
    await stopped
    await created
  }
})
