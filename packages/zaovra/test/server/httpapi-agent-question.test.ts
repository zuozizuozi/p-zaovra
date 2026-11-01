import { expect, test } from "bun:test"
import path from "node:path"
import { Schema } from "effect"
import { createZaovraClient } from "@zaovra-ai/sdk/v2"
import { Server } from "../../src/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

for (const fixture of [
  { agent: "build", allowed: true, automatic: false, resolution: "reply" },
  { agent: "work-developer", allowed: false, automatic: false, resolution: "reply" },
  { agent: "build", allowed: false, automatic: true, resolution: "reply" },
  { agent: "build", allowed: true, automatic: false, resolution: "unavailable" },
  { agent: "build", allowed: true, automatic: false, resolution: "dismiss" },
  { agent: "build", allowed: true, automatic: false, resolution: "stop" },
]) {
  test(`fixed provider question: ${fixture.agent}, automatic=${fixture.automatic}, resolution=${fixture.resolution}`, async () => {
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
    let resolved = false
    let transcript = ""
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const pending = Schema.decodeUnknownSync(
        Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
      )(await (await app.request(`/api/session/${id}/question`, { headers })).json()).data
      if (!fixture.allowed) expect(pending).toEqual([])
      if (pending.length && fixture.allowed && !resolved && fixture.resolution !== "reply") {
        if (fixture.resolution === "unavailable") {
          const other = await app.request("/api/session", {
            method: "POST",
            headers,
            body: JSON.stringify({ id: id + "_other", location: { directory: tmp.path } }),
          })
          expect(other.status).toBe(200)
          await using transport = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
          const sdk = createZaovraClient({ baseUrl: `http://127.0.0.1:${transport.port}`, headers })
          const denied = await sdk.v2.session.question.reject({
            sessionID: id + "_other",
            requestID: pending[0]!.id,
            reason: "unavailable",
          })
          expect(denied.response.status).toBe(404)
          const invalid = await app.request(`/api/session/${id}/question/${pending[0]!.id}/reject?reason=other`, {
            method: "POST",
            headers,
          })
          expect(invalid.status).toBe(400)
          const rejected = await sdk.v2.session.question.reject({
            sessionID: id,
            requestID: pending[0]!.id,
            reason: "unavailable",
          })
          expect(rejected.response.status).toBe(204)
        }
        if (fixture.resolution === "dismiss") {
          const rejected = await app.request(`/api/session/${id}/question/${pending[0]!.id}/reject`, {
            method: "POST",
            headers,
          })
          expect(rejected.status).toBe(204)
        }
        if (fixture.resolution === "stop") {
          const stopped = await app.request(`/api/session/${id}/interrupt`, { method: "POST", headers })
          expect(stopped.status).toBe(204)
        }
        resolved = true
      }
      if (pending.length && fixture.allowed && fixture.resolution === "reply") {
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
      if (
        (fixture.resolution === "dismiss" || fixture.resolution === "stop") &&
        resolved &&
        transcript.includes("Tool execution interrupted")
      )
        break
      await Bun.sleep(25)
    }
    if (fixture.resolution === "dismiss" || fixture.resolution === "stop") {
      expect(requests).toHaveLength(1)
      expect(answered).toBe(false)
      expect(transcript).toContain("Tool execution interrupted")
      expect(transcript).not.toContain("QUESTION_FIXTURE_DONE")
      return
    }
    expect(requests).toHaveLength(2)
    expect(requests[0]!.tools.some((tool) => tool.function.name === "question")).toBe(fixture.allowed)
    expect(answered).toBe(fixture.allowed && fixture.resolution === "reply")
    expect(transcript).toContain("QUESTION_FIXTURE_DONE")
    expect(transcript).toContain(
      fixture.resolution === "unavailable"
        ? "No user answer or approval was given"
        : fixture.allowed
          ? "Keep (Recommended)"
          : "Tool question is disabled",
    )
  }, 25_000)
}
