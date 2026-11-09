import { afterEach, expect, test } from "bun:test"
import { Context } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>
function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-zaovra-directory", encodeURIComponent(directory))
  return HttpApiApp.webHandler().handler(new Request(`http://localhost${route}`, { ...init, headers }), context)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("766 actual HTTP handler resolves the saved integration key without returning secrets or generating", async () => {
  const observed: Array<{ key: string | null; header: string | null; method: string }> = []
  let fail = false
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      observed.push({ key: req.headers.get("Authorization"), header: req.headers.get("X-Saved"), method: req.method })
      if (fail) return new Response("synthetic-private-response", { status: 401 })
      return Response.json({ data: [{ id: "auto" }, { id: "deepseek-v4.1-flash" }, { id: "gpt-6-luna" }] })
    },
  })
  try {
    await using tmp = await tmpdir({
      git: true,
      config: {
        provider: {
          "api-gravitex-ai": {
            npm: "@ai-sdk/openai",
            options: { baseURL: upstream.url.origin, headers: { "X-Saved": "synthetic-header" } },
            models: { "deepseek-v4.1-flash": { provider: { npm: "@ai-sdk/openai-compatible" } }, "gpt-6-luna": {} },
          },
        },
      },
    })
    const connected = await request("/api/integration/api-gravitex-ai/connect/key", tmp.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "synthetic-key-766", inputs: {} }),
    })
    expect(connected.status).toBe(204)
    const listed = await request("/api/provider/api-gravitex-ai/models", tmp.path)
    expect(listed.status).toBe(200)
    const result = await listed.text()
    expect(JSON.parse(result).data).toEqual([
      { id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash" },
      { id: "gpt-6-luna", name: "gpt-6-luna" },
    ])
    expect(result).not.toContain("synthetic-key-766")
    expect(result).not.toContain("synthetic-header")
    expect(observed).toEqual([{ key: "Bearer synthetic-key-766", header: "synthetic-header", method: "GET" }])
    fail = true
    const failed = await request("/api/provider/api-gravitex-ai/models", tmp.path)
    expect(failed.status).toBe(503)
    const message = await failed.text()
    expect(message).not.toContain("synthetic-private-response")
    expect(message).not.toContain("synthetic-key-766")
    expect((await request("/api/provider/missing-provider/models", tmp.path)).status).toBe(404)
    expect(observed.every((item) => item.method === "GET")).toBe(true)
  } finally {
    await upstream.stop(true)
  }
}, 30000)
