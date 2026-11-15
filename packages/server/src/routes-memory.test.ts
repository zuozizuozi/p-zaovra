import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"

const root = process.env.ZAOVRA_SERVER_TEST_DIR
if (!root || !path.isAbsolute(root)) throw new Error("Use an isolated absolute ZAOVRA_SERVER_TEST_DIR")
for (const [key, directory] of Object.entries({
  HOME: "home",
  USERPROFILE: "home",
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state",
  TEMP: "temp",
  TMP: "temp",
  TMPDIR: "temp",
})) {
  process.env[key] = path.join(root, directory)
  await fs.mkdir(process.env[key]!, { recursive: true })
}
process.env.ZAOVRA_TEST_HOME = path.join(root, "home")
process.env.ZAOVRA_DISABLE_MODELS_FETCH = "true"
process.env.ZAOVRA_CONFIG_CONTENT = "{}"
process.env.ZAOVRA_DB = ":memory:"
const { createEmbeddedRoutes } = await import("./routes")
const { Layer } = await import("effect")
const { HttpRouter, HttpServer } = await import("effect/unstable/http")

test("production routes bind tidy globals outside Location without starting a provider", async () => {
  const directory = path.join(root!, "project")
  await fs.mkdir(directory, { recursive: true })
  const web = HttpRouter.toWebHandler(createEmbeddedRoutes().pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => web.handler(request) })
  const url = (suffix = "") =>
    new URL("/api/memory/tidy" + suffix + "?location%5Bdirectory%5D=" + encodeURIComponent(directory), server.url)
  try {
    const prepared = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestID: "production-admit-only",
        model: { id: "offline", providerID: "offline" },
        tokens: 1000,
        dailyTokens: 2000,
      }),
    })
    expect(prepared.status).toBe(200)
    const task = (await prepared.json()).data
    expect(task.executing).toBe(false)
    expect(task.state).toBe("active")
    const listed = await fetch(url())
    expect(listed.status).toBe(200)
    expect((await listed.json()).data.map((item: { id: string }) => item.id)).toEqual([task.id])
    const stopped = await fetch(url(`/${task.id}/cancel`), { method: "POST" })
    expect(stopped.status).toBe(200)
    expect((await stopped.json()).data).toMatchObject({
      id: task.id,
      state: "cancelled",
      executing: false,
      usage: { charged: 0, unknown: 0 },
    })
  } finally {
    server.stop(true)
    await web.dispose()
  }
}, 30000)
