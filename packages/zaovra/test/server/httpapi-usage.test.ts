import { expect, test } from "bun:test"
import path from "node:path"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

test("real session execution persists provider usage and serves conversation and overall totals", async () => {
  await using tmp = await tmpdir({ git: true })
  let calls = 0
  await using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls += 1
      const tool = calls % 2 === 1
      const chunk = (choices: unknown[], usage?: object) =>
        `data: ${JSON.stringify({ id: "usage", object: "chat.completion.chunk", created: 1, model: "usage-model", choices, usage })}\n\n`
      return new Response(
        chunk([
          {
            index: 0,
            delta: tool
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_usage_${calls}`,
                      type: "function",
                      function: { name: "glob", arguments: JSON.stringify({ pattern: "*.json" }) },
                    },
                  ],
                }
              : { role: "assistant", content: "Usage recorded." },
            finish_reason: null,
          },
        ]) +
          chunk([{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }]) +
          chunk([], {
            prompt_tokens: 170,
            completion_tokens: 45,
            total_tokens: 215,
            prompt_tokens_details: { cached_tokens: 50 },
            completion_tokens_details: { reasoning_tokens: 5 },
          }) +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  await Bun.write(
    path.join(tmp.path, "zaovra.json"),
    JSON.stringify({
      model: "usage-fixture/usage-model",
      provider: {
        "usage-fixture": {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
          models: { "usage-model": { limit: { context: 32000, output: 1024 } } },
        },
      },
    }),
  )
  const app = Server.Default().app
  const headers = { "content-type": "application/json", "x-zaovra-directory": tmp.path }
  const id = `ses_usage_${Date.now()}`
  const created = await app.request("/api/session", {
    method: "POST",
    headers,
    body: JSON.stringify({
      id,
      location: { directory: tmp.path },
      model: { id: "usage-model", providerID: "usage-fixture" },
    }),
  })
  expect(created.status, await created.clone().text()).toBe(200)
  for (const turn of [1, 2]) {
    const admitted = await app.request(`/api/session/${id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: `msg_usage_${Date.now()}_${turn}`, prompt: { text: `Say hello ${turn}.` } }),
    })
    expect(admitted.status, await admitted.clone().text()).toBe(200)
    const wait = await app.request(`/api/session/${id}/wait`, { method: "POST", headers })
    expect(wait.status, await wait.clone().text()).toBe(204)
    const response = await app.request(`/api/usage?sessionID=${id}`, { headers })
    expect(response.status, await response.clone().text()).toBe(200)
    const summary = await response.json()
    expect(summary.data.total.total).toBe(430 * turn)
    expect(summary.data.lastTurn.total).toBe(430)
    expect(summary.data.total.unreported).toBe(0)
    expect(summary.data.own.cacheRead).toBe(100 * turn)
    expect(summary.data.own.reasoning).toBe(10 * turn)
  }
  const deleted = await app.request(`/api/session/${id}`, { method: "DELETE", headers })
  expect(deleted.status).toBe(204)
  const summary = await (await app.request("/api/usage", { headers })).json()
  expect(summary.data.own.total).toBeGreaterThanOrEqual(860)
  expect(calls).toBe(4)
  expect(summary.data.billing).toBe("unavailable")
}, 25_000)
