import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { AppRuntime } from "../../src/effect/app-runtime"
import { disposeAllInstances } from "./fixture"
const root = process.env.ZAOVRA_SERVER_TEST_DIR
if (!root || !path.isAbsolute(root)) throw new Error("Use isolated ZAOVRA_SERVER_TEST_DIR")
test("legacy production listeners share tidy ownership and reopening cannot release unknown charges", async () => {
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
  await AppRuntime.runPromise(Effect.void)
  const listen = () => Server.listen({ hostname: "127.0.0.1", port: 0 })
  const first = await listen()
  const second = await listen()
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
  let reopened: Awaited<ReturnType<typeof listen>> | undefined
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
    reopened = await listen()
    const read = (suffix = "", body?: unknown) => call(reopened!.url, a, suffix, body)
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
    await reopened?.stop(true)
    await disposeAllInstances()
    await AppRuntime.dispose()
    await provider.stop(true)
  }
}, 30000)
