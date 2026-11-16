import { expect, test } from "bun:test"
import path from "node:path"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { Zaovra } from "@zaovra-ai/client"
import { Database } from "@zaovra-ai/core/database/database"
import { ModelMemoryProfile } from "@zaovra-ai/core/model-memory-profile"
import { MemoryNoteTable } from "@zaovra-ai/core/memory/sql"
import { EventTable } from "@zaovra-ai/core/event/sql"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { LocationServiceMap } from "@zaovra-ai/core/location-services"
import { SessionRuntime } from "../../src/effect/session-runtime"
import { seedPoison } from "../../script/evaluation/memory-fixture"
import { createLayer, observeRuntime } from "../../script/evaluation/runtime-idle"
import { Server } from "../../src/server/server"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { disposeAllInstances } from "./fixture"
import { pollWithTimeout } from "../lib/effect"

const root = process.env.ZAOVRA_SERVER_TEST_DIR
if (!root || !path.isAbsolute(root)) throw new Error("Use isolated ZAOVRA_SERVER_TEST_DIR")

test("HTTP memory leaf and monitor share explicit host; default stays unknown", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const requests: Array<{ group: string; names: string[]; results: string[] }> = []
  const counts = new Map<string, number>()
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const group = new URL(request.url).pathname.split("/")[1]!
      const body = (await request.json()) as {
        tools?: Array<{ function: { name: string } }>
        messages: Array<{ role: string; content?: unknown }>
      }
      requests.push({
        group,
        names: (body.tools ?? []).map((tool) => tool.function.name),
        results: body.messages
          .filter((message) => message.role === "tool")
          .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))),
      })
      const round = (counts.get(group) ?? 0) + 1
      counts.set(group, round)
      if (round > 3) return Response.json({ error: { message: "fixture limit" } }, { status: 400 })
      if (group === "c" && round === 1) {
        entered.resolve()
        await release.promise
      }
      const call =
        round === 1
          ? { name: "tool_search", arguments: { names: ["memory_note", "memory_search"] } }
          : round === 2
            ? {
                name: "memory_note",
                arguments: { kind: "decision", text: `host-note-${group}`, basis: "fixed local fixture" },
              }
            : undefined
      const chunk = (choices: unknown[], usage?: object) =>
        `data: ${JSON.stringify({ id: `host-${group}-${round}`, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices, usage })}\n\n`
      return new Response(
        chunk([
          {
            index: 0,
            delta: call
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `host-call-${round}`,
                      type: "function",
                      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                    },
                  ],
                }
              : { role: "assistant", content: "Done." },
            finish_reason: null,
          },
        ]) +
          chunk([{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }]) +
          chunk([], { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }) +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const host = SessionRuntime.create([
    [
      ModelMemoryProfile.node,
      Layer.succeed(
        ModelMemoryProfile.Service,
        ModelMemoryProfile.Service.of({
          // Deliberately test-only. This is not the real model/endpoint permission matcher.
          memoryNote: (model, variant) =>
            model.id === "fixture-model" && model.providerID === "fixture" && variant === undefined ? true : undefined,
        }),
      ),
    ],
    [Database.node, Database.layerFromPath(path.join(root, "host-c.db"))],
  ])
  const scope = Scope.makeUnsafe()
  const listeners: Server.Listener[] = []
  try {
    const contexts = []
    for (const [group, runtime] of [
      ["c", host],
      ["b", SessionRuntime],
    ] as const) {
      const directory = path.join(root, group)
      await Bun.write(
        path.join(directory, "zaovra.json"),
        JSON.stringify({
          model: "fixture/fixture-model",
          memory: { enabled: true, taskSearch: group === "c" },
          permission: { "*": "allow" },
          formatter: false,
          lsp: false,
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/${group}/v1`, apiKey: "fixture" },
              models: { "fixture-model": { tool_call: true, limit: { context: 32000, output: 1024 } } },
            },
          },
        }),
      )
      const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, ...(group === "c" ? { runtime } : {}) })
      listeners.push(listener)
      const context = await Effect.runPromise(
        Layer.buildWithMemoMap(createLayer(runtime), Layer.makeMemoMapUnsafe(), scope),
      )
      const observer = () => Effect.runPromise(observeRuntime.pipe(Effect.provide(context)))
      const client = Zaovra.make({
        baseUrl: listener.url.toString(),
        headers: { "x-zaovra-directory": encodeURIComponent(directory) },
      })
      const session = await client.sessions.create({
        location: { directory },
        model: { id: "fixture-model", providerID: "fixture" },
      })
      contexts.push({ group, runtime, context, observer, client, session })
    }
    const c = contexts[0]!
    const b = contexts[1]!
    expect(Context.get(c.context, SessionExecution.Service)).not.toBe(Context.get(b.context, SessionExecution.Service))
    expect(Context.get(c.context, LocationServiceMap.Service)).not.toBe(
      Context.get(b.context, LocationServiceMap.Service),
    )
    await c.client.sessions.prompt({ sessionID: c.session.id, prompt: { text: "Remember the fixture decision." } })
    await Effect.runPromise(Effect.promise(() => entered.promise).pipe(Effect.timeout("10 seconds")))
    expect(await c.observer()).toMatchObject({ idle: false, active: { execution: 1 } })
    expect(await b.observer()).toMatchObject({ idle: true, active: { execution: 0 } })
    release.resolve()
    for (const item of contexts) {
      if (item.group === "b")
        await item.client.sessions.prompt({
          sessionID: item.session.id,
          prompt: { text: "Remember the fixture decision." },
        })
      await Effect.runPromise(
        pollWithTimeout(
          Effect.promise(async () => ((await item.observer()).idle ? true : undefined)),
          "host did not settle",
          "15 seconds",
        ),
      )
      const databaseContext = await Effect.runPromise(
        Layer.buildWithMemoMap(
          item.runtime.share(AppNodeBuilderV1.build(Database.node, item.runtime.replacements)),
          Layer.makeMemoMapUnsafe(),
          scope,
        ),
      )
      const database = Context.get(databaseContext, Database.Service)
      const notes = await Effect.runPromise(database.db.select().from(MemoryNoteTable).all())
      const saved = notes.filter((note) => note.text === `host-note-${item.group}`)
      expect(saved.length, JSON.stringify({ requests, notes })).toBe(item.group === "c" ? 1 : 0)
      if (item.group === "c") {
        expect(saved[0]).toMatchObject({ origin: "model", status: "unverified", session_id: item.session.id })
        expect(saved[0]!.seq).toBeGreaterThan(0)
        const events = await Effect.runPromise(database.db.select().from(EventTable).all())
        expect(
          events.some(
            (event) =>
              event.aggregate_id === item.session.id &&
              event.seq === saved[0]!.seq &&
              JSON.stringify(event.data).includes("memory_note"),
          ),
        ).toBe(true)
      }
      if (item.group === "c") {
        // Separate artificial fixture: never count this direct write as the model leaf above.
        const poison = await seedPoison(
          { chain: "billing", directory: path.join(root, "c"), sourceSessionID: item.session.id },
          host,
        )
        expect(poison.before).toHaveLength(1)
        expect(poison.after).toHaveLength(2)
        const after = await Effect.runPromise(database.db.select().from(MemoryNoteTable).all())
        expect(after.some((note) => note.id === poison.inserted)).toBe(true)
      }
      if (item.group === "b") expect(notes).toHaveLength(0)
      const own = requests.filter((request) => request.group === item.group)
      expect(own.length).toBe(3)
      expect(own[1]!.names.includes("memory_note")).toBe(item.group === "c")
      expect(own[1]!.names).toContain("memory_search")
      expect(JSON.parse(own[2]!.results.at(-1)!)).toMatchObject({ kept: item.group === "c" })
    }
  } finally {
    release.resolve()
    for (const listener of listeners) await listener.stop(true)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await disposeAllInstances()
    await provider.stop(true)
  }
}, 45000)
