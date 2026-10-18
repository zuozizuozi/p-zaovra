import { expect } from "bun:test"
import { LLM, Message, ToolDefinition } from "@zaovra-ai/llm"
import { LLMClient, RequestExecutor } from "@zaovra-ai/llm/route"
import { DateTime, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { SessionRunnerModel } from "@zaovra-ai/core/session/runner/model"
import { SessionV2 } from "@zaovra-ai/core/session"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { it } from "./lib/effect"

const catalog = (url: string, body: Record<string, unknown>) =>
  ModelV2.Info.make({
    id: ModelV2.ID.make("deepseek-v4.1-flash"),
    providerID: ProviderV2.ID.make("gravitex"),
    name: "DeepSeek fixture",
    api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url, id: ModelV2.ID.make("deepseek-v4.1-flash") },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: {}, body: {} },
    variants: [{ id: ModelV2.VariantID.make("fixture"), headers: {}, body: { max_tokens: 32000, ...body } }],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 1000000, output: 384000 },
  })

const session = SessionV2.Info.make({
  id: SessionV2.ID.make("ses_deepseek_wire"),
  projectID: ProjectV2.ID.global,
  title: "wire fixture",
  model: {
    id: ModelV2.ID.make("deepseek-v4.1-flash"),
    providerID: ProviderV2.ID.make("gravitex"),
    variant: ModelV2.VariantID.make("fixture"),
  },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: { directory: AbsolutePath.make("/project") },
})

for (const effort of [undefined, "low", "high", "max", "xhigh", "disabled"]) {
  it.effect(`DeepSeek K1 wire ${effort ?? "default"} survives tool history and compacted history`, () =>
    Effect.gen(function* () {
      const received: Record<string, unknown>[] = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
              received.push(
                Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await request.json()),
              )
              const delta =
                received.length === 1
                  ? {
                      reasoning_content: "fixture reasoning",
                      tool_calls: [
                        { index: 0, id: "c1", type: "function", function: { name: "read", arguments: "{}" } },
                      ],
                    }
                  : { content: "Done" }
              return new Response(
                `data: ${JSON.stringify({ choices: [{ delta, finish_reason: received.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } },
              )
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const resolved = yield* SessionRunnerModel.resolve(
        session,
        catalog(
          `http://127.0.0.1:${server.port}/v1`,
          effort === undefined
            ? {}
            : effort === "disabled"
              ? { thinking: { type: "disabled" } }
              : { thinking: { type: "enabled" }, reasoning_effort: effort },
        ),
      )
      const fixed = {
        system: "Stable fixture rules",
        tools: [
          ToolDefinition.make({
            name: "read",
            description: "Read fixture",
            inputSchema: { type: "object", properties: {} },
          }),
        ],
      }
      const first = yield* LLMClient.generate(LLM.request({ ...fixed, model: resolved, prompt: "Read the fixture" }))
      expect(first.reasoning).toBe("fixture reasoning")
      yield* LLMClient.generate(
        LLM.request({
          ...fixed,
          model: resolved,
          messages: [
            Message.user("Read the fixture"),
            first.message,
            Message.tool({ id: "c1", name: "read", result: "fixture" }),
          ],
        }),
      )
      yield* LLMClient.generate(
        LLM.request({
          ...fixed,
          model: resolved,
          messages: [Message.user("Compacted: the fixture was read. Deliver.")],
        }),
      )
      expect(received).toHaveLength(3)
      expect(JSON.stringify(received[1].tools)).toBe(JSON.stringify(received[0].tools))
      const initialMessages = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(received[0].messages)
      const continuedMessages = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(received[1].messages)
      expect(JSON.stringify(continuedMessages.slice(0, initialMessages.length))).toBe(JSON.stringify(initialMessages))
      for (const body of received) {
        expect(body).toMatchObject({
          model: "deepseek-v4.1-flash",
          thinking: { type: effort === "disabled" ? "disabled" : "enabled" },
          max_tokens: 32000,
        })
        if (effort === "disabled") expect(body).not.toHaveProperty("reasoning_effort")
        else expect(body).toHaveProperty("reasoning_effort", effort === "xhigh" ? "high" : (effort ?? "high"))
        for (const key of ["max_completion_tokens", "max_output_tokens", "budget_tokens", "reasoning"])
          expect(body).not.toHaveProperty(key)
      }
      expect(received[1]).toMatchObject({
        messages: [
          { role: "system", content: "Stable fixture rules" },
          { role: "user" },
          { role: "assistant", reasoning_content: "fixture reasoning", tool_calls: [{ id: "c1" }] },
          { role: "tool", tool_call_id: "c1" },
        ],
      })
      expect(JSON.stringify(received[2])).not.toContain("fixture reasoning")
    }).pipe(
      Effect.provide(
        LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer)))),
      ),
    ),
  )
}

for (const body of [
  { reasoning_effort: "mystery" },
  { thinking: { type: "adaptive" } },
  { thinking: { type: "enabled", budget_tokens: 1000 } },
  { thinking: { type: "disabled" }, reasoning_effort: "high" },
]) {
  it.effect(`DeepSeek K1 rejects unsupported or conflicting options ${JSON.stringify(body)}`, () =>
    Effect.gen(function* () {
      const error = yield* SessionRunnerModel.resolve(session, catalog("http://127.0.0.1:1/v1", body)).pipe(
        Effect.flatMap((model) => LLMClient.prepare(LLM.request({ model, prompt: "Never sent" }))),
        Effect.flip,
      )
      expect(String(error)).toContain("DeepSeek")
    }),
  )
}
