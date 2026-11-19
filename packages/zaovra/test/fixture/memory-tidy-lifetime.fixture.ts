import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@zaovra-ai/core/database/database"
import { MemoryAutomaticTable } from "@zaovra-ai/core/memory/automatic.sql"
import { Server } from "../../src/server/server"
import { AppRuntime } from "../../src/effect/app-runtime"
import { disposeAllInstances } from "./fixture"
const root = process.env.ZAOVRA_SERVER_TEST_DIR
if (!root || !path.isAbsolute(root)) throw new Error("Use isolated ZAOVRA_SERVER_TEST_DIR")
test("legacy production listeners share tidy ownership and reopening cannot release unknown charges", async () => {
  const entered = Promise.withResolvers<void>()
  let sends = 0
  let counts = 0
  let failCount = true
  const requests: string[] = []
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const route = new URL(request.url).pathname
      requests.push(route)
      if (route.endsWith("/input_tokens")) {
        counts++
        if (failCount) return new Response(null, { status: 404 })
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
        memory: { enabled: true },
        experimental: { verification: false, delivery_contract: false },
        provider: {
          chat: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: provider.url.href + "v1", apiKey: "offline" },
            models: { fixture: { limit: { context: 32000, output: 32 } } },
          },
          fixture: {
            npm: "@ai-sdk/openai",
            options: { baseURL: provider.url.href + "v1", apiKey: "offline" },
            models: {
              fixture: { limit: { context: 32000, output: 32 } },
              alternate: { limit: { context: 32000, output: 32 } },
            },
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
    const automatic = new URL("/api/memory/automatic", first.url)
    automatic.searchParams.set("location[directory]", a)
    for (const providerID of ["chat", "missing-provider"]) {
      const denied = { ...confirmation, model: { providerID, id: "fixture" } }
      const manual = await call(first.url, a, "", denied)
      expect(manual.status, await manual.clone().text()).toBe(409)
      expect((await manual.json()).reason).toBe("invalid")
      const consent = await fetch(automatic, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(denied),
      })
      expect(consent.status, await consent.clone().text()).toBe(409)
      expect((await consent.json()).reason).toBe("invalid")
    }
    expect(await (await fetch(automatic)).json()).toEqual({ data: null })
    expect((await (await call(first.url, a)).json()).data).toEqual([])
    const confirm = (body: typeof confirmation & { expected?: string } = confirmation, base = automatic) =>
      fetch(base, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    const unverified = await confirm()
    expect(unverified.status, await unverified.clone().text()).toBe(409)
    expect((await unverified.json()).reason).toBe("count")
    expect([counts, sends]).toEqual([0, 0])
    const missing = await call(first.url, a, "", { ...confirmation, requestID: "missing-input-count" })
    expect(missing.status, await missing.clone().text()).toBe(200)
    const missingID = (await missing.json()).data.id
    expect((await call(first.url, a, "/" + missingID + "/start", {})).status).toBe(200)
    let uncounted = (await (await call(first.url, a, "/" + missingID)).json()).data
    for (let index = 0; index < 150 && uncounted.state === "active"; index++) {
      await Bun.sleep(30)
      uncounted = (await (await call(first.url, a, "/" + missingID)).json()).data
    }
    expect(uncounted.state).toBe("failed")
    expect(uncounted.usage.reserved).toBe(0)
    expect([counts, sends]).toEqual([1, 0])
    const stillUnverified = await confirm()
    expect(stillUnverified.status).toBe(409)
    expect((await stillUnverified.json()).reason).toBe("count")
    expect(await (await fetch(automatic)).json()).toEqual({ data: null })
    expect([counts, sends]).toEqual([1, 0])
    failCount = false
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
    expect(counts).toBe(2)
    const consent = await confirm()
    expect(consent.status, await consent.clone().text()).toBe(200)
    expect((await consent.json()).data.countVerified).toBe(true)
    const replacement = await confirm({
      ...confirmation,
      expected: confirmation.requestID,
      requestID: "replace",
      model: { providerID: "chat", id: "fixture" },
    })
    expect(replacement.status).toBe(409)
    expect((await (await fetch(automatic)).json()).data.generation).toBe(confirmation.requestID)
    const alternate = await confirm({
      ...confirmation,
      expected: confirmation.requestID,
      requestID: "replace-model",
      model: { providerID: "fixture", id: "alternate" },
    })
    expect(alternate.status, await alternate.clone().text()).toBe(409)
    expect((await alternate.json()).reason).toBe("count")
    expect([counts, sends]).toEqual([2, 1])
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
    expect((await read("/" + task.id + "/start", {})).status).toBe(409)
    const usage = await fetch(new URL("/api/usage?memoryTidy=separate", reopened.url))
    expect(usage.status, await usage.clone().text()).toBe(200)
    const totals = (await usage.json()).data
    expect(totals.memoryTidy).toEqual({ known: 0, reserved: 132, unknown: 1, countBilling: "unavailable" })
    expect(totals.total.calls).toBe(0)
    const sessionUsage = new URL("/api/usage?memoryTidy=separate", reopened.url)
    sessionUsage.searchParams.set("sessionID", task.sessionID)
    const conversation = await fetch(sessionUsage)
    expect(conversation.status, await conversation.clone().text()).toBe(200)
    expect((await conversation.json()).data.memoryTidySession).toBe(true)
    await read()
    expect(sends).toBe(1)
    const cancelled = (await (await read("/" + task.id + "/cancel", {})).json()).data
    expect(cancelled.state).toBe("cancelled")
    expect(cancelled.usage).toEqual(live.usage)
    await read("/" + task.id + "/start", {})
    expect(sends).toBe(1)
    const reloaded = new URL(automatic.pathname + automatic.search, reopened.url)
    expect((await (await fetch(reloaded)).json()).data).toMatchObject({ countVerified: true, enabled: true })
    const config = new URL("/config", reopened.url)
    config.searchParams.set("directory", a)
    const patched = await fetch(config, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: { fixture: { options: { baseURL: provider.url.href + "alternate/v1" } } } }),
    })
    expect(patched.status, await patched.clone().text()).toBe(200)
    expect((await (await fetch(reloaded)).json()).data).toMatchObject({ countVerified: false, enabled: true })
    const changedRoute = await confirm(
      {
        ...confirmation,
        expected: confirmation.requestID,
        requestID: "replace-route",
      },
      reloaded,
    )
    expect(changedRoute.status, await changedRoute.clone().text()).toBe(409)
    expect((await changedRoute.json()).reason).toBe("count")
    const legacy = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* db
          .update(MemoryAutomaticTable)
          .set({ count_binding: null })
          .where(eq(MemoryAutomaticTable.generation, confirmation.requestID))
          .returning({ generation: MemoryAutomaticTable.generation })
          .get()
      }),
    )
    expect(legacy?.generation).toBe(confirmation.requestID)
    expect((await (await fetch(reloaded)).json()).data).toMatchObject({
      generation: confirmation.requestID,
      countVerified: false,
      enabled: true,
      currentRun: null,
    })
    expect(requests).toEqual(["/v1/responses/input_tokens", "/v1/responses/input_tokens", "/v1/responses"])
  } finally {
    await first.stop(true)
    await second.stop(true)
    await reopened?.stop(true)
    await disposeAllInstances()
    await AppRuntime.dispose()
    await provider.stop(true)
  }
}, 30000)
