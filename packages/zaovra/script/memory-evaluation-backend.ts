import path from "node:path"
import { link, lstat, writeFile } from "node:fs/promises"

// Standalone evaluation entrypoint. Never imported by the normal application.
const [ready, generation, fixtureFile] = process.argv.slice(2)
if (!ready || !path.isAbsolute(ready) || !/^[a-f0-9-]{36}$/.test(generation ?? ""))
  throw new Error("invalid-evaluation-host-arguments")
for (const name of [
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "ZAOVRA_TEST_HOME",
  "ZAOVRA_TEST_MANAGED_CONFIG_DIR",
  "ZAOVRA_DB",
]) {
  if (!process.env[name] || !path.isAbsolute(process.env[name]!)) throw new Error("missing-isolated-evaluation-path")
}
// Product modules initialize paths while loading, so validate isolation before importing them.
const { ManagedRuntime } = await import("effect")
const { memoMap } = await import("@zaovra-ai/core/effect/memo-map")
const { Server } = await import("../src/server/server")
const { layer, observeRuntime } = await import("./evaluation/runtime-idle")
const runtime = ManagedRuntime.make(layer, { memoMap })
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
if (!(await runtime.runPromise(observeRuntime)).idle) throw new Error("evaluation-runtime-not-idle-at-start")
if (fixtureFile) {
  if (!path.isAbsolute(fixtureFile) || path.dirname(fixtureFile) !== path.dirname(ready))
    throw new Error("invalid-evaluation-fixture-path")
  const info = await lstat(fixtureFile)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096)
    throw new Error("invalid-evaluation-fixture-file")
  const { Schema } = await import("effect")
  const request = Schema.decodeUnknownSync(
    Schema.Struct({ chain: Schema.String, directory: Schema.String, sourceSessionID: Schema.String }),
  )(await Bun.file(fixtureFile).json())
  const { seedPoison } = await import("./evaluation/memory-fixture")
  const snapshot = await seedPoison(request)
  await writeFile(path.join(path.dirname(ready), "fixture.json"), JSON.stringify(snapshot), { flag: "wx" })
}
if (process.platform === "win32") {
  // This headless process owns no interactive console; never exempt a leftover host from Job checks.
  const { dlopen, FFIType } = await import("bun:ffi")
  const kernel = dlopen("kernel32.dll", { FreeConsole: { args: [], returns: FFIType.i32 } })
  try {
    if (kernel.symbols.FreeConsole() === 0) throw new Error("evaluation-console-detach-failed")
  } finally {
    kernel.close()
  }
}
const monitor = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    // Read-only experiment IPC; no addition to the public product API or generated client.
    if (request.method !== "GET" || new URL(request.url).pathname !== "/runtime")
      return new Response(null, { status: 404 })
    const state = await runtime.runPromise(observeRuntime)
    return Response.json({ generation, pid: process.pid, ...state }, { headers: { "cache-control": "no-store" } })
  },
})
try {
  await writeFile(
    ready + ".tmp",
    JSON.stringify({ generation, pid: process.pid, api: listener.url.toString(), monitor: monitor.url.toString() }),
    { flag: "wx" },
  )
  // Publish complete bytes without overwriting an existing readiness record.
  await link(ready + ".tmp", ready)
} catch {
  await monitor.stop(true)
  await listener.stop(true)
  await runtime.dispose()
  throw new Error("evaluation-host-ready-failed")
}
