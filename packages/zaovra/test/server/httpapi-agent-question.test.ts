import { expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { Server } from "../../src/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

for (const fixture of [
  { agent: "build", allowed: true, automatic: false },
  { agent: "work-developer", allowed: false, automatic: false },
  { agent: "build", allowed: false, automatic: true },
]) {
  test(`fixed provider question: ${fixture.agent}, automatic=${fixture.automatic}`, async () => {
    await using tmp = await tmpdir({ git: true })
    const requests: Array<{ tools: ReadonlyArray<{ function: { name: string } }> }> = []
    const Request = Schema.Struct({
      tools: Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
      messages: Schema.Array(Schema.Struct({ role: Schema.String })),
    })
    const input = {
      questions: [
        {
          header: "Data",
          question: "Keep or delete existing data?",
          options: [
            { label: "Keep (Recommended)", description: "Preserve existing data" },
            { label: "Delete", description: "Remove existing data" },
          ],
        },
      ],
    }
    await using provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = Schema.decodeUnknownSync(Request)(await request.json())
        requests.push(body)
        // Send a stale call even when question is absent: permission enforcement must settle it.
        const done = body.messages.some((message) => message.role === "tool")
        const chunk = (delta: object, finish_reason: string | null = null) =>
          `data: ${JSON.stringify({ id: "question-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        return new Response(
          chunk({ role: "assistant" }) +
            chunk(
              done
                ? { content: "QUESTION_FIXTURE_DONE" }
                : {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_question",
                        type: "function",
                        function: { name: "question", arguments: JSON.stringify(input) },
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
        model: "fixture/fixture",
        formatter: false,
        lsp: false,
        experimental: { verification: false },
        ...(fixture.automatic ? { permission: { question: "deny" } } : {}),
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
            models: { fixture: { limit: { context: 32000, output: 1024 } } },
          },
        },
      }),
    )
    const app = Server.Default().app
    const headers = { "content-type": "application/json", "x-zaovra-directory": encodeURIComponent(tmp.path) }
    const id = `ses_question_${fixture.agent}_${Date.now()}`
    await using cleanup = {
      async [Symbol.asyncDispose]() {
        await app.request(`/api/session/${id}/interrupt`, { method: "POST", headers })
        await disposeAllInstances()
      },
    }
    const created = await app.request("/api/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ id, location: { directory: tmp.path } }),
    })
    expect(created.status, await created.clone().text()).toBe(200)
    const admitted = await app.request(`/api/session/${id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: `msg_question_${Date.now()}`,
        prompt: {
          text: "Clarify before deleting data.",
          selection: { agent: fixture.agent, model: { id: "fixture", providerID: "fixture" } },
        },
      }),
    })
    expect(admitted.status, await admitted.clone().text()).toBe(200)
    let answered = false
    let transcript = ""
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const pending = Schema.decodeUnknownSync(
        Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
      )(await (await app.request(`/api/session/${id}/question`, { headers })).json()).data
      if (!fixture.allowed) expect(pending).toEqual([])
      if (pending.length && fixture.allowed) {
        const reply = await app.request(`/api/session/${id}/question/${pending[0]!.id}/reply`, {
          method: "POST",
          headers,
          body: JSON.stringify({ answers: [["Keep (Recommended)"]] }),
        })
        expect(reply.status, await reply.clone().text()).toBe(204)
        answered = true
      }
      transcript = await (await app.request(`/api/session/${id}/context`, { headers })).text()
      if (transcript.includes("QUESTION_FIXTURE_DONE") && transcript.includes('"finish":"stop"')) break
      await Bun.sleep(25)
    }
    expect(requests).toHaveLength(2)
    expect(requests[0]!.tools.some((tool) => tool.function.name === "question")).toBe(fixture.allowed)
    expect(answered).toBe(fixture.allowed)
    expect(transcript).toContain("QUESTION_FIXTURE_DONE")
    expect(transcript).toContain(fixture.allowed ? "Keep (Recommended)" : "Tool question is disabled")
  }, 25_000)
}
