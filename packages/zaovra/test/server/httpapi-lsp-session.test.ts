import { expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

test("LSP status observes the language service used by a durable session", async () => {
  await using tmp = await tmpdir({ git: true })
  const Request = Schema.Struct({ messages: Schema.Array(Schema.Struct({ role: Schema.String })) })
  await using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = Schema.decodeUnknownSync(Request)(await request.json())
      const done = body.messages.some((message) => message.role === "tool")
      const chunk = (delta: object, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: "audit", object: "chat.completion.chunk", created: 1, model: "audit-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      return new Response(
        chunk({ role: "assistant" }) +
          chunk(
            done
              ? { content: "LSP_SESSION_OK" }
              : {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_lsp_write",
                      type: "function",
                      function: {
                        name: "write",
                        arguments: JSON.stringify({ path: "sample.audit", content: "bad\n" }),
                      },
                    },
                  ],
                },
          ) +
          chunk({}, done ? "stop" : "tool_calls") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  await Bun.write(
    path.join(tmp.path, "zaovra.json"),
    JSON.stringify({
      model: "audit/audit-model",
      permission: { edit: "allow" },
      formatter: false,
      lsp: {
        audit: {
          extensions: [".audit"],
          command: [
            "node",
            path.resolve(import.meta.dir, "../../../core/test/fixture/lsp-diagnostics.cjs"),
            path.join(tmp.path, "lsp.log"),
          ],
        },
      },
      provider: {
        audit: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
          models: { "audit-model": { limit: { context: 32000, output: 1024 } } },
        },
      },
    }),
  )
  const app = Server.Default().app
  const headers = { "content-type": "application/json", "x-zaovra-directory": tmp.path }
  await using cleanup = {
    async [Symbol.asyncDispose]() {
      // Release the cached fixture process even when a later assertion fails.
      await app.request("/config", { method: "PATCH", headers, body: JSON.stringify({ lsp: false }) })
    },
  }
  const id = `ses_lsp_status_${Date.now()}`
  const created = await app.request("/api/session", {
    method: "POST",
    headers,
    body: JSON.stringify({ id, location: { directory: tmp.path }, model: { id: "audit-model", providerID: "audit" } }),
  })
  expect(created.status, await created.clone().text()).toBe(200)
  const admitted = await app.request(`/api/session/${id}/prompt`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: `msg_lsp_${Date.now()}`, prompt: { text: "Write the sample file." } }),
  })
  expect(admitted.status, await admitted.clone().text()).toBe(200)
  const deadline = Date.now() + 10_000
  let transcript = ""
  while (Date.now() < deadline) {
    transcript = await (await app.request(`/api/session/${id}/context`, { headers })).text()
    if (transcript.includes("LSP_SESSION_OK")) break
    await Bun.sleep(50)
  }
  expect(transcript).toContain("LSP_SESSION_OK")
  expect(transcript).toContain("Bad text")
  const status = await app.request("/lsp", { headers })
  expect(status.status).toBe(200)
  expect(await status.json()).toContainEqual({ id: "audit", name: "audit", root: "", status: "connected" })
}, 20_000)
