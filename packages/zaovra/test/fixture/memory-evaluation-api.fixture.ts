import { expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Zaovra } from "@zaovra-ai/client"
import { observe } from "../../../../script/evaluation/memory/observe"
import { Server } from "../../src/server/server"
import { AppRuntime } from "../../src/effect/app-runtime"
import { disposeAllInstances } from "./fixture"
import { pollWithTimeout } from "../lib/effect"

const root = process.env.ZAOVRA_SERVER_TEST_DIR
if (!root || !path.isAbsolute(root)) throw new Error("Use isolated ZAOVRA_SERVER_TEST_DIR")

test("real completed and pending admissions stay distinct without inventing background proof", async () => {
  let calls = 0
  // Only the upstream is scripted. Session admission, execution, projection and HTTP reads are real.
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++
      const chunk = (choices: unknown[], usage?: object) =>
        `data: ${JSON.stringify({ id: "observation", object: "chat.completion.chunk", created: 1, model: "observer-model", choices, usage })}\n\n`
      return new Response(
        chunk([{ index: 0, delta: { role: "assistant", content: "Hello." }, finish_reason: null }]) +
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
      model: "observer-fixture/observer-model",
      memory: { enabled: false },
      provider: {
        "observer-fixture": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
          models: { "observer-model": { limit: { context: 32000, output: 1024 } } },
        },
      },
    }),
  )
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const client = Zaovra.make({
    baseUrl: listener.url.toString(),
    headers: { "x-zaovra-directory": encodeURIComponent(root) },
  })
  const signal = AbortSignal.timeout(25000)
  try {
    const session = await client.sessions.create(
      {
        location: { directory: root },
        model: { id: "observer-model", providerID: "observer-fixture" },
      },
      { signal },
    )
    const admission = await client.sessions.prompt(
      { sessionID: session.id, prompt: { text: "Say hello only. Do not use tools." } },
      { signal },
    )
    // Poll the observed completion predicate, not a fixed sleep or the existence of any old assistant.
    const observed = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const result = await observe({ client, admission, attempts: 1 })
          return result.reason === "background-not-independently-confirmed" ? result : undefined
        }),
        "the actual admitted turn never reached a completed snapshot",
        "15 seconds",
      ),
    )
    expect(calls).toBeGreaterThan(0)
    expect(observed.artifactReady).toBe(false)
    expect(observed.turn).toBeUndefined()
    expect(observed.evidence).toHaveLength(2)
    expect(observed.evidence[0].fingerprint).toBe(observed.evidence[1].fingerprint)
    const pending = await client.sessions.prompt(
      { sessionID: session.id, resume: false, prompt: { text: "Not executed yet." } },
      { signal },
    )
    expect(pending.id).not.toBe(admission.id)
    const incomplete = await observe({ client, admission: pending, attempts: 1 })
    expect(incomplete.artifactReady).toBe(false)
    expect(incomplete.turn).toBeUndefined()
    expect(incomplete.reason).toBe("snapshot-not-idle")
  } finally {
    await listener.stop(true)
    await disposeAllInstances()
    await AppRuntime.dispose()
    await provider.stop(true)
  }
}, 30000)
