import { expect, test } from "bun:test"
import path from "node:path"
import { Context, DateTime, Effect, Exit, Layer, Scope } from "effect"
import { Zaovra } from "@zaovra-ai/client"
import { BackgroundJob } from "@zaovra-ai/core/background-job"
import { EventV2 } from "@zaovra-ai/core/event"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionSchema } from "@zaovra-ai/core/session/schema"
import { AppNodeBuilderV1 } from "../../src/effect/app-node-builder-v1"
import { SessionRuntime } from "../../src/effect/session-runtime"
import { layer, observeRuntime } from "../../script/evaluation/runtime-idle"
import { Server } from "../../src/server/server"
import { AppRuntime } from "../../src/effect/app-runtime"
import { disposeAllInstances } from "./fixture"
import { pollWithTimeout } from "../lib/effect"

const root = process.env.ZAOVRA_SERVER_TEST_DIR
if (!root || !path.isAbsolute(root)) throw new Error("Use isolated ZAOVRA_SERVER_TEST_DIR")

test("shared host sees actual runner, Core jobs, durable shell and pending work", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      calls++
      entered.resolve()
      await release.promise
      const chunk = (choices: unknown[], usage?: object) =>
        `data: ${JSON.stringify({ id: "runtime-fixture", object: "chat.completion.chunk", created: 1, model: "runtime-model", choices, usage })}\n\n`
      return new Response(
        chunk([{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }]) +
          chunk([{ index: 0, delta: {}, finish_reason: "stop" }]) +
          chunk([], { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }) +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  await Bun.write(
    path.join(root, "zaovra.json"),
    JSON.stringify({
      model: "runtime-fixture/runtime-model",
      memory: { enabled: false },
      provider: {
        "runtime-fixture": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
          models: { "runtime-model": { limit: { context: 32000, output: 1024 } } },
        },
      },
    }),
  )
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const scope = await Effect.runPromise(Scope.make())
  try {
    // A fresh outer memo map, as with HTTP listeners. SessionRuntime.share must bridge it.
    const host = await Effect.runPromise(Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope))
    const read = () => Effect.runPromise(observeRuntime.pipe(Effect.provide(host)))
    expect(await read()).toMatchObject({
      idle: true,
      reason: "idle-observed",
      active: { execution: 0, tidy: 0, background: 0 },
    })
    const client = Zaovra.make({
      baseUrl: listener.url.toString(),
      headers: { "x-zaovra-directory": encodeURIComponent(root) },
    })
    const signal = AbortSignal.timeout(25000)
    const session = await client.sessions.create(
      { location: { directory: root }, model: { id: "runtime-model", providerID: "runtime-fixture" } },
      { signal },
    )
    await client.sessions.prompt({ sessionID: session.id, prompt: { text: "Say done only." } }, { signal })
    await Effect.runPromise(Effect.promise(() => entered.promise).pipe(Effect.timeout("10 seconds")))
    const running = await read()
    expect(running.idle).toBe(false)
    expect(running.active?.execution).toBeGreaterThan(0)
    release.resolve()
    const settled = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const value = await read()
          return value.idle ? value : undefined
        }),
        "shared execution did not settle",
        "10 seconds",
      ),
    )
    expect(settled.revision).toBeGreaterThan(running.revision!)
    expect(calls).toBe(1)

    // A separately built Core producer graph uses the exact global layer the runner tools depend on.
    // This is an actual scoped registry/job, not AppRuntime's legacy per-Instance table or a mock.
    const producer = await Effect.runPromise(
      Layer.buildWithMemoMap(
        SessionRuntime.share(AppNodeBuilderV1.build(BackgroundJob.node)),
        Layer.makeMemoMapUnsafe(),
        scope,
      ),
    )
    const jobs = Context.get(producer, BackgroundJob.Service)
    expect(jobs).toBe(Context.get(host, BackgroundJob.Service))
    const job = await Effect.runPromise(jobs.start({ type: "evaluation-fixture", run: Effect.never }))
    try {
      expect(await read()).toMatchObject({ idle: false, active: { execution: 0, background: 1 } })
    } finally {
      await Effect.runPromise(jobs.cancel(job.id))
    }
    expect(await read()).toMatchObject({ idle: true, active: { background: 0 } })

    // Real event projection creates a durable unfinished shell without launching a shell process.
    const events = await AppRuntime.runPromise(EventV2.Service)
    const sessionID = SessionSchema.ID.make(session.id)
    await Effect.runPromise(
      events.publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        callID: "runtime-shell-fixture",
        command: "fixture-only",
        origin: "manual",
        timestamp: DateTime.nowUnsafe(),
      }),
    )
    expect(await read()).toMatchObject({ idle: false, reason: "busy", active: { execution: 0, background: 0 } })
    await Effect.runPromise(
      events.publish(SessionEvent.Shell.Ended, {
        sessionID,
        callID: "runtime-shell-fixture",
        output: "",
        timestamp: DateTime.nowUnsafe(),
      }),
    )
    expect(await read()).toMatchObject({ idle: true })
    await client.sessions.prompt(
      { sessionID: session.id, resume: false, prompt: { text: "Durable pending only." } },
      { signal },
    )
    expect(await read()).toMatchObject({
      idle: false,
      reason: "busy",
      active: { execution: 0, tidy: 0, background: 0 },
    })
    expect(calls).toBe(1)
    expect(JSON.stringify(await read())).not.toContain(session.id)
  } finally {
    release.resolve()
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await listener.stop(true)
    await disposeAllInstances()
    await AppRuntime.dispose()
    await provider.stop(true)
  }
}, 30000)
