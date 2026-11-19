import { expect, setSystemTime, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Clock, Effect } from "effect"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Memory } from "@zaovra-ai/schema/memory"
import { Database } from "@zaovra-ai/core/database/database"
import { MemoryNoteTable } from "@zaovra-ai/core/memory/sql"
import { MemoryTidyAttemptTable, MemoryTidyDayTable, MemoryTidyRunTable } from "@zaovra-ai/core/memory/tidy.sql"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { SessionV2 } from "@zaovra-ai/core/session"
import { createZaovraClient, type MemoryTidyTask } from "@zaovra-ai/sdk/v2/client"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Server } from "../../src/server/server"
import { disposeAllInstances } from "./fixture"

const root = process.env.ZAOVRA_SERVER_TEST_DIR
if (!root || !path.isAbsolute(root)) throw new Error("An isolated server directory is required")

const sse = (...frames: unknown[]) =>
  new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })

test("saved tool work, UTC retry, new run ceiling, failures and cancelled work on the product path", async () => {
  const day = "2026-11-19"
  const today = new Date(day + "T23:50:00Z")
  const tomorrow = new Date("2026-11-20T00:01:00Z")
  const directory = path.join(root, "project")
  await mkdir(directory, { recursive: true })
  const model = { providerID: ProviderV2.ID.make("fixture"), id: ModelV2.ID.make("fixture") }
  const requests: { kind: "count" | "generate"; input: string }[] = []
  let noteID: string | undefined
  let sendTool = false
  let failCount = false
  await using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { input: unknown }
      const input = JSON.stringify(body.input)
      if (new URL(request.url).pathname.endsWith("/input_tokens")) {
        requests.push({ kind: "count", input })
        return failCount
          ? new Response(null, { status: 404 })
          : Response.json({ object: "response.input_tokens", input_tokens: 100 })
      }
      requests.push({ kind: "generate", input })
      const finish = {
        type: "response.completed",
        response: {
          status: "completed",
          id: "resp_fixture_" + requests.length,
          model: "fixture",
          usage: { input_tokens: 55, output_tokens: 5, total_tokens: 60 },
        },
      }
      if (!sendTool)
        return sse({ type: "response.output_text.delta", item_id: "msg_fixture", delta: "Finished." }, finish)
      sendTool = false
      const item = {
        type: "function_call",
        id: "fc_fixture",
        call_id: "call_fixture",
        name: "memory_review",
      }
      const args = JSON.stringify({
        layer: "project",
        decisions: [{ id: noteID, action: "stale", basis: "Fixture checked the original source" }],
      })
      return sse(
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: args },
        { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed", arguments: args } },
        finish,
      )
    },
  })
  const config = (enabled: boolean) =>
    Bun.write(
      path.join(directory, "zaovra.json"),
      JSON.stringify({
        formatter: false,
        lsp: false,
        memory: { enabled },
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
  const listen = () => Server.listen({ hostname: "127.0.0.1", port: 0 })
  const generations = () => requests.filter((request) => request.kind === "generate")
  await config(true)
  await AppRuntime.runPromise(Effect.void)
  let server = await listen()
  const call = (suffix = "", body?: unknown, checkpoint?: string, resumeTokens?: number) => {
    const url = new URL("/api/memory" + suffix, server.url)
    url.searchParams.set("location[directory]", directory)
    if (checkpoint !== undefined) url.searchParams.set("checkpoint", checkpoint)
    if (resumeTokens !== undefined) url.searchParams.set("resumeTokens", String(resumeTokens))
    return fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  const task = async (id: string): Promise<MemoryTidyTask> => (await (await call("/tidy/" + id)).json()).data
  const wait = async (id: string, ready: (result: MemoryTidyTask) => boolean) => {
    for (let index = 0; index < 180; index++) {
      const result = await task(id)
      if (!result.executing && ready(result)) return result
      await Bun.sleep(35)
    }
    throw new Error(JSON.stringify({ task: await task(id), requests: requests.map((item) => item.kind) }))
  }
  const restart = async () => {
    await server.stop(true)
    await disposeAllInstances()
    server = await listen()
  }
  const enable = async (enabled: boolean) => {
    const url = new URL("/config", server.url)
    url.searchParams.set("directory", directory)
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memory: { enabled } }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
  }
  const start = (id: string, checkpoint?: string, resumeTokens?: number) =>
    call("/tidy/" + id + "/start", {}, checkpoint, resumeTokens).then((response) => ({ response }))
  const prepare = async (requestID: string, tokens: number): Promise<MemoryTidyTask> => {
    // The real model picker initializes the Location's catalog before authorizing tidy.
    const modelURL = new URL("/api/model", server.url)
    modelURL.searchParams.set("location[directory]", directory)
    const available = (await (await fetch(modelURL)).json()) as { data: { id: string; providerID: string }[] }
    expect(available.data.some((item) => item.id === model.id && item.providerID === model.providerID)).toBe(true)
    const response = await call("/tidy", { requestID, model, tokens, dailyTokens: 300 })
    expect(response.status, await response.clone().text()).toBe(200)
    return (await response.json()).data
  }
  try {
    const daily = await prepare("daily", 250)
    setSystemTime(today)
    expect(await Effect.runPromise(Clock.currentTimeMillis)).toBe(today.getTime())
    // A separate historical unknown must keep its charge and must never be resumed.
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.insert(MemoryTidyDayTable).values({ day, token_limit: 300 }).run()
        yield* db
          .insert(MemoryTidyRunTable)
          .values({
            id: "fixture-older",
            request_id: "fixture-older",
            state: "cancelled",
            session_id: SessionV2.ID.create(),
            directory,
            scope: Memory.Scope.user,
            model,
            token_limit: 300,
            daily_limit: 300,
            time_created: today.getTime(),
          })
          .run()
        yield* db
          .insert(MemoryTidyAttemptTable)
          .values({
            id: "fixture-older-attempt",
            run_id: "fixture-older",
            day,
            reserved: 130,
            time_created: today.getTime(),
          })
          .run()
      }),
    )
    noteID = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const run = yield* db.select().from(MemoryTidyRunTable).where(eq(MemoryTidyRunTable.id, daily.id)).get()
        if (!run) throw new Error("Missing prepared task")
        const id = Memory.ID.create()
        yield* db
          .insert(MemoryNoteTable)
          .values({
            id,
            scope: run.scope,
            key: "fixture:bad",
            text: "Bad historical note",
            kind: "practice",
            origin: "model",
            status: "unverified",
            time_observed: today.getTime(),
          })
          .run()
        return id
      }),
    )
    sendTool = true
    expect((await start(daily.id)).response.status).toBe(200)
    const paused = await wait(daily.id, (value) => !!value.budgetPause)
    expect(paused.budgetPause?.budget).toBe("day")
    expect(paused.budgetPause?.utcDay).toBe(day)
    expect(paused.usage).toMatchObject({ known: 60, charged: 60, unknown: 0 })
    expect(requests.map((request) => request.kind)).toEqual(["count", "generate", "count"])
    const notes = async (): Promise<{ id: string; status: string }[]> => (await (await call()).json()).data
    const note = (await notes()).find((value) => value.id === noteID)
    expect(note?.status).toBe("stale")
    expect((await start(daily.id, paused.budgetPause?.id)).response.status).toBe(409)
    expect((await start(daily.id)).response.status).toBe(409)
    expect(requests).toHaveLength(3)

    await restart()
    setSystemTime(tomorrow)
    const persisted = await task(daily.id)
    expect(persisted.budgetPause).toEqual(paused.budgetPause)
    await enable(false)
    expect((await start(daily.id, paused.budgetPause?.id)).response.status).toBe(409)
    expect(requests).toHaveLength(3)
    await enable(true)
    const retries = await Promise.all([
      start(daily.id, paused.budgetPause?.id),
      start(daily.id, paused.budgetPause?.id),
    ])
    expect(retries.map((item) => item.response.status)).toEqual([200, 200])
    const done = await wait(daily.id, (value) => value.state === "completed")
    expect(done.sessionID).toBe(daily.sessionID)
    expect(done.usage).toMatchObject({ known: 120, charged: 120, unknown: 0 })
    expect(generations()).toHaveLength(2)
    expect(generations()[1].input).toContain("function_call_output")
    expect((await notes()).find((value) => value.id === noteID)).toEqual(note)
    const aggregate = (
      await createZaovraClient({ baseUrl: server.url.href }).v2.session.usage(
        { memoryTidy: "separate" },
        { throwOnError: true },
      )
    ).data.data
    expect(aggregate.memoryTidy).toMatchObject({ known: 120, reserved: 130, unknown: 1 })

    const bounded = await prepare("run", 160)
    sendTool = true
    await start(bounded.id)
    const runPause = await wait(bounded.id, (value) => !!value.budgetPause)
    expect(runPause.budgetPause).toMatchObject({ budget: "run" })
    expect(generations()).toHaveLength(3)
    expect((await start(bounded.id, runPause.budgetPause?.id)).response.status).toBe(409)
    expect((await start(bounded.id, "stale", 230)).response.status).toBe(409)
    expect((await start(bounded.id, runPause.budgetPause?.id, 230)).response.status).toBe(200)
    const renewed = await wait(bounded.id, (value) => value.state === "completed")
    expect(renewed.tokens).toBe(160)
    expect(renewed.resumedTokenLimit).toBe(230)
    expect(renewed.usage.known).toBe(120)
    expect(generations()).toHaveLength(4)
    expect((await start(bounded.id, runPause.budgetPause?.id, 230)).response.status).toBe(200)
    expect(generations()).toHaveLength(4)

    const failing = await prepare("failing", 250)
    failCount = true
    await start(failing.id)
    const stopped = await wait(failing.id, (value) => value.state === "failed")
    expect(stopped.budgetPause).toBeUndefined()
    const sent = requests.length
    expect((await start(failing.id)).response.status).toBe(200)
    const cancelled = await prepare("cancelled", 250)
    expect((await call("/tidy/" + cancelled.id + "/cancel", {})).status).toBe(200)
    expect((await start(cancelled.id)).response.status).toBe(200)
    expect(requests).toHaveLength(sent)
  } finally {
    await server.stop(true)
    await disposeAllInstances()
    await AppRuntime.dispose()
    setSystemTime()
  }
}, 45_000)
