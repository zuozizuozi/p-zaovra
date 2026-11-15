import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"

const root = process.env.ZAOVRA_SERVER_TEST_DIR
if (!root || !path.isAbsolute(root)) throw new Error("Use isolated ZAOVRA_SERVER_TEST_DIR")
for (const [key, leaf] of Object.entries({
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
  process.env[key] = path.join(root, leaf)
  await fs.mkdir(process.env[key]!, { recursive: true })
}
process.env.ZAOVRA_TEST_HOME = path.join(root, "home")
process.env.ZAOVRA_DISABLE_MODELS_FETCH = "true"
process.env.ZAOVRA_CONFIG_CONTENT = "{}"
process.env.ZAOVRA_DB = path.join(root, "lifetime.sqlite")
const { createEmbeddedRoutes } = await import("./routes")
const { Layer } = await import("effect")
const { HttpRouter, HttpServer } = await import("effect/unstable/http")

test("production tidy retains execution across listener close, isolates directories and reopens without spending", async () => {
  const entered = Promise.withResolvers<void>()
  let sends = 0
  let counts = 0
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith("/input_tokens")) {
        counts++
        return Response.json({ object: "response.input_tokens", input_tokens: 100 })
      }
      sends++
      entered.resolve()
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": held\n\n"))
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const open = () =>
    HttpRouter.toWebHandler(createEmbeddedRoutes().pipe(Layer.provide(HttpServer.layerServices)), {
      disableLogger: true,
    })
  const web = open()
  const listen = () => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => web.handler(request) })
  const first = listen()
  const second = listen()
  const a = path.join(root!, "a")
  const b = path.join(root!, "b")
  for (const directory of [a, b]) {
    await fs.mkdir(directory, { recursive: true })
    await Bun.write(
      path.join(directory, "zaovra.json"),
      JSON.stringify({
        formatter: false,
        lsp: false,
        experimental: { verification: false, delivery_contract: false },
        provider: {
          fixture: {
            npm: "@ai-sdk/openai",
            options: { baseURL: provider.url.href + "v1", apiKey: "offline" },
            models: { fixture: { limit: { context: 32000, output: 32 } } },
          },
        },
      }),
    )
  }
  const call = async (base: URL, directory: string, suffix = "", body?: unknown, layer = "project") => {
    const url = new URL("/api/memory/tidy" + suffix, base)
    url.searchParams.set("location[directory]", directory)
    url.searchParams.set("layer", layer)
    return fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  const confirmation = {
    requestID: "lifetime-a",
    model: { providerID: "fixture", id: "fixture" },
    tokens: 1000,
    dailyTokens: 2000,
  }
  let reopened: ReturnType<typeof open> | undefined
  try {
    const prepared = await call(first.url, a, "", confirmation)
    expect(prepared.status, await prepared.clone().text()).toBe(200)
    const task = (await prepared.json()).data
    const retry = (await (await call(second.url, a, "", confirmation)).json()).data
    expect(retry.id).toBe(task.id)
    expect((await (await call(second.url, b)).json()).data).toEqual([])
    for (const action of ["", "/start", "/cancel"]) {
      const wrong = await call(second.url, b, "/" + task.id + action, action ? {} : undefined)
      expect(wrong.status, await wrong.clone().text()).toBe(409)
    }
    const started = await call(first.url, a, "/" + task.id + "/start", {})
    expect(started.status, await started.clone().text()).toBe(200)
    const timeout = setTimeout(() => entered.reject(new Error("Provider did not enter within 10 seconds")), 10000)
    try {
      await entered.promise
    } finally {
      clearTimeout(timeout)
    }
    expect(sends).toBe(1)
    expect(counts).toBe(1)
    await first.stop(true)
    const live = (await (await call(second.url, a, "/" + task.id)).json()).data
    expect(live.executing).toBe(true)
    expect(live.usage.unknown).toBe(1)
    expect(live.usage.reserved).toBe(132)
    await call(second.url, a, "/" + task.id + "/start", {})
    expect(sends).toBe(1)
    // Dispose the final application owner, not merely its transport listener.
    await second.stop(true)
    await web.dispose()
    reopened = open()
    const read = async (suffix = "", body?: unknown) => {
      const url = new URL("http://localhost/api/memory/tidy" + suffix)
      url.searchParams.set("location[directory]", a)
      return reopened!.handler(
        new Request(url, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
    }
    const paused = (await (await read("/" + task.id)).json()).data
    expect(paused.state).toBe("active")
    expect(paused.executing).toBe(false)
    expect(paused.usage).toEqual(live.usage)
    await read()
    expect(sends).toBe(1)
    const cancelled = (await (await read("/" + task.id + "/cancel", {})).json()).data
    expect(cancelled.state).toBe("cancelled")
    expect(cancelled.usage).toEqual(live.usage)
    await read("/" + task.id + "/start", {})
    expect(sends).toBe(1)
  } finally {
    await first.stop(true)
    await second.stop(true)
    await web.dispose()
    await reopened?.dispose()
    await provider.stop(true)
  }
}, 30000)
