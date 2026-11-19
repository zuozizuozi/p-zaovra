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

const enabledConfig = {
  memory: { enabled: true },
  provider: {
    offline: {
      npm: "@ai-sdk/openai",
      options: { baseURL: "http://127.0.0.1:1/v1" },
      models: { offline: { limit: { context: 32000, output: 32 } } },
    },
  },
}

test("production routes bind tidy globals outside Location without starting a provider", async () => {
  const directory = path.join(root!, "project")
  await fs.mkdir(directory, { recursive: true })
  await Bun.write(path.join(directory, "zaovra.json"), JSON.stringify(enabledConfig))
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

test("automatic HTTP settings default off, isolate directories and reject stale consent", async () => {
  const directory = path.join(root!, "automatic-project")
  await fs.mkdir(directory, { recursive: true })
  await Bun.write(path.join(directory, "zaovra.json"), JSON.stringify(enabledConfig))
  const web = HttpRouter.toWebHandler(createEmbeddedRoutes().pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  })
  const call = (method = "GET", body?: unknown, suffix = "", target = directory) => {
    const url = new URL("http://localhost/api/memory/automatic" + suffix)
    url.searchParams.set("location[directory]", target)
    return web.handler(
      new Request(url, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
  }
  const consent = {
    requestID: "automatic-http",
    model: { id: "offline", providerID: "offline" },
    tokens: 100,
    dailyTokens: 200,
  }
  try {
    expect((await (await call()).json()).data).toBeNull()
    const confirmed = await call("PUT", consent)
    expect(confirmed.status, await confirmed.clone().text()).toBe(200)
    expect((await confirmed.json()).data).toMatchObject({
      enabled: true,
      generation: consent.requestID,
      currentRun: null,
      tokens: 100,
    })
    expect((await (await call("PUT", consent)).json()).data.generation).toBe(consent.requestID)
    expect((await call("PUT", { ...consent, tokens: 101 })).status).toBe(409)
    expect(
      (await call("PUT", { ...consent, requestID: "invalid", expected: consent.requestID, tokens: 201 })).status,
    ).toBe(409)
    const other = path.join(root!, "automatic-other")
    await fs.mkdir(other, { recursive: true })
    expect((await (await call("GET", undefined, "", other)).json()).data).toBeNull()
    expect((await call("POST", { expected: "stale" }, "/disable")).status).toBe(409)
    expect((await (await call("POST", { expected: consent.requestID }, "/disable")).json()).data.enabled).toBe(false)
    // A response lost before disable cannot re-enable the same authorization.
    expect((await (await call("PUT", consent)).json()).data.enabled).toBe(false)
    expect((await call("PUT", { ...consent, requestID: "next" })).status).toBe(409)
    expect(
      (await (await call("PUT", { ...consent, requestID: "next", expected: consent.requestID })).json()).data.enabled,
    ).toBe(true)
    expect((await (await call()).json()).data.currentRun).toBeNull()
  } finally {
    await web.dispose()
  }
}, 30000)

test("production routes without memory opt-in refuse tidy and automation without creating a task", async () => {
  const directory = path.join(root!, "default-off-project")
  await fs.mkdir(directory, { recursive: true })
  const web = HttpRouter.toWebHandler(createEmbeddedRoutes().pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  })
  const call = (endpoint: string, method = "GET") => {
    const url = new URL(`http://localhost/api/memory/${endpoint}`)
    url.searchParams.set("location[directory]", directory)
    return web.handler(
      new Request(url, {
        method,
        headers: { "content-type": "application/json" },
        body:
          method === "GET"
            ? undefined
            : JSON.stringify({
                requestID: "default-off",
                model: { id: "offline", providerID: "offline" },
                tokens: 100,
                dailyTokens: 200,
              }),
      }),
    )
  }
  try {
    expect((await (await call("automatic")).json()).data).toBeNull()
    for (const [endpoint, method] of [
      ["tidy", "POST"],
      ["automatic", "PUT"],
    ]) {
      const denied = await call(endpoint!, method!)
      expect(denied.status).toBe(409)
      expect((await denied.json()).reason).toBe("unauthorized")
    }
    expect((await (await call("tidy")).json()).data).toEqual([])
    expect((await (await call("automatic")).json()).data).toBeNull()
  } finally {
    await web.dispose()
  }
}, 30000)
