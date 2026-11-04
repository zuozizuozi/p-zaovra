import { expect } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM, Message } from "../../src"
import { Anthropic, Google, OpenAI, OpenAICompatible, OpenRouter } from "../../src/providers"
import { LLMClient } from "../../src/route"
import { testEffect } from "../lib/effect"
import { runtimeLayer } from "../lib/http"
import { sseEvents } from "../lib/sse"

// These are wire-contract fixtures, not evidence that an upstream model is reachable.
// Every configured endpoint is replaced with this test's ephemeral loopback listener.
const suppliers = [
  { id: "openai", protocol: "responses", model: "gpt-5-mini", prefix: "/v1" },
  { id: "anthropic", protocol: "anthropic", model: "claude-sonnet-4-6", prefix: "/v1" },
  { id: "gemini", protocol: "gemini", model: "gemini-2.5-flash", prefix: "/v1beta" },
  { id: "openrouter", protocol: "openrouter", model: "deepseek/deepseek-chat", prefix: "/api/v1" },
  { id: "deepseek", protocol: "chat", model: "deepseek-chat", prefix: "/v1" },
  { id: "qwen", protocol: "chat", model: "qwen3.5-plus", prefix: "/compatible-mode/v1" },
  { id: "zhipu", protocol: "chat", model: "glm-4.5", prefix: "/api/paas/v4" },
  { id: "kimi", protocol: "chat", model: "kimi-k2-thinking", prefix: "/v1" },
  { id: "doubao", protocol: "chat", model: "doubao-seed-2-1-pro-260915", prefix: "/api/v3" },
  { id: "minimax", protocol: "chat", model: "MiniMax-M3.1-Flash", prefix: "/v1" },
  { id: "bailing", protocol: "chat", model: "Ling-3.0-flash", prefix: "/v1" },
  { id: "hunyuan", protocol: "chat", model: "hunyuan-turbos-latest", prefix: "/v1" },
  { id: "qianfan", protocol: "chat", model: "deepseek-v3.2", prefix: "/v2" },
  { id: "siliconflow", protocol: "chat", model: "deepseek-ai/DeepSeek-V3.2", prefix: "/v1" },
  { id: "gravitex", protocol: "responses", model: "gpt-6-luna", prefix: "/v1" },
  { id: "wangsu", protocol: "chat", model: "deployment-id-not-verified", prefix: "/v1" },
  { id: "ollama", protocol: "chat", model: "qwen3:8b", prefix: "/v1" },
  { id: "lmstudio", protocol: "chat", model: "openai/gpt-oss-20b", prefix: "/v1" },
] as const

type Supplier = (typeof suppliers)[number]
type Wire = { path: string; method: string; raw: string; body: unknown; auth: string | null; fixtureResponse: string }
const reason = "Synthetic reasoning 580"
const args = { query: "synthetic-580" }
const tools = [
  {
    name: "lookup",
    description: "Read synthetic data only",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
]

function fixture(supplier: Supplier, tool: boolean) {
  const protocol = supplier.protocol
  if (protocol === "responses")
    return tool
      ? sseEvents(
          { type: "response.reasoning_summary_text.delta", item_id: "rs_580", delta: reason },
          {
            type: "response.output_item.done",
            item: {
              type: "reasoning",
              id: "rs_580",
              encrypted_content: "synthetic-encrypted-580",
              summary: [{ type: "summary_text", text: reason }],
            },
          },
          {
            type: "response.output_item.added",
            item: { type: "function_call", id: "item_580", call_id: "call_580", name: "lookup", arguments: "" },
          },
          { type: "response.function_call_arguments.delta", item_id: "item_580", delta: JSON.stringify(args) },
          {
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "item_580",
              call_id: "call_580",
              name: "lookup",
              arguments: JSON.stringify(args),
            },
          },
          { type: "response.completed", response: { id: "resp_580" } },
        )
      : sseEvents(
          { type: "response.output_text.delta", item_id: "msg_580", delta: "Synthetic answer 580" },
          { type: "response.completed", response: { id: "resp_580" } },
        )
  if (protocol === "anthropic")
    return sseEvents(
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      ...(tool
        ? [
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: reason } },
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_580" } },
            { type: "content_block_stop", index: 0 },
            {
              type: "content_block_start",
              index: 1,
              content_block: { type: "tool_use", id: "call_580", name: "lookup", input: {} },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(args) },
            },
            { type: "content_block_stop", index: 1 },
          ]
        : [
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Synthetic answer 580" } },
            { type: "content_block_stop", index: 0 },
          ]),
      { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    )
  if (protocol === "gemini")
    return sseEvents({
      candidates: [
        {
          content: {
            role: "model",
            parts: tool
              ? [
                  { text: reason, thought: true, thoughtSignature: "sig_thought_580" },
                  { functionCall: { name: "lookup", args }, thoughtSignature: "sig_tool_580" },
                ]
              : [{ text: "Synthetic answer 580" }],
          },
          finishReason: "STOP",
        },
      ],
    })
  return sseEvents({
    choices: [
      {
        delta: tool
          ? {
              ...(protocol === "openrouter"
                ? { reasoning_details: [{ type: "reasoning.text", index: 0, text: reason, signature: "sig_580" }] }
                : supplier.id === "lmstudio"
                  ? { reasoning: reason }
                  : { reasoning_content: reason }),
              ...(supplier.id === "doubao" ? { encrypted_content: "synthetic-encrypted-doubao-580" } : {}),
              tool_calls: [
                {
                  index: 0,
                  id: "call_580",
                  type: "function",
                  function: { name: "lookup", arguments: JSON.stringify(args) },
                },
              ],
            }
          : { content: "Synthetic answer 580" },
        finish_reason: tool ? "tool_calls" : "stop",
      },
    ],
  })
}

function model(supplier: Supplier, baseURL: string) {
  const config = { baseURL, apiKey: "sk-synthetic-local-580" }
  if (supplier.id === "openai") return OpenAI.configure(config).responses(supplier.model)
  if (supplier.id === "anthropic") return Anthropic.configure(config).model(supplier.model)
  if (supplier.id === "gemini") return Google.configure(config).model(supplier.model)
  if (supplier.id === "openrouter") return OpenRouter.configure(config).model(supplier.model)
  if (supplier.id === "gravitex") return OpenAI.configure(config).responses(supplier.model)
  if (supplier.id === "deepseek") return OpenAICompatible.deepseek.configure(config).model(supplier.model)
  return OpenAICompatible.configure({ ...config, provider: supplier.id }).model(supplier.model)
}

const it = testEffect(runtimeLayer(FetchHttpClient.layer))
for (const supplier of suppliers) {
  it.live(`580 ${supplier.id}: actual loopback first/history/tool/reasoning wire`, () =>
    Effect.gen(function* () {
      const wires: Wire[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          const raw = await request.text()
          const response = fixture(supplier, wires.length === 2)
          wires.push({
            path: url.pathname + url.search,
            method: request.method,
            raw,
            body: JSON.parse(raw),
            auth:
              request.headers.get("authorization") ??
              request.headers.get("x-api-key") ??
              request.headers.get("x-goog-api-key"),
            fixtureResponse: response,
          })
          return new Response(response, {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      return yield* Effect.gen(function* () {
        const selected = model(supplier, `http://127.0.0.1:${server.port}${supplier.prefix}`)
        const initial = [Message.user("First synthetic request 580")]
        const first = yield* LLMClient.generate(LLM.request({ model: selected, messages: initial, cache: "none" }))
        expect(first.text).toBe("Synthetic answer 580")
        const history = [...initial, first.message, Message.user("Second synthetic request 580")]
        const second = yield* LLMClient.generate(LLM.request({ model: selected, messages: history, cache: "none" }))
        expect(second.text).toBe("Synthetic answer 580")
        const toolHistory = [...history, second.message, Message.user("Use lookup for synthetic-580")]
        const third = yield* LLMClient.generate(
          LLM.request({ model: selected, messages: toolHistory, tools, cache: "none" }),
        )
        const call = third.events.find((event) => event.type === "tool-call")
        expect(call).toMatchObject({ name: "lookup", input: args })
        const last = yield* LLMClient.generate(
          LLM.request({
            model: selected,
            messages: [
              ...toolHistory,
              third.message,
              Message.tool({ id: call!.id, name: "lookup", result: { found: "synthetic-580" } }),
            ],
            tools,
            cache: "none",
          }),
        )
        expect(last.text).toBe("Synthetic answer 580")
        expect(wires).toHaveLength(4)
        expect(wires.every((wire) => wire.method === "POST")).toBe(true)
        expect(wires.every((wire) => wire.auth?.includes("sk-synthetic-local-580"))).toBe(true)
        const suffix =
          supplier.protocol === "responses"
            ? "/responses"
            : supplier.protocol === "anthropic"
              ? "/messages"
              : supplier.protocol === "gemini"
                ? `/models/${supplier.model}:streamGenerateContent?alt=sse`
                : "/chat/completions"
        expect(wires.every((wire) => wire.path === supplier.prefix + suffix)).toBe(true)
        expect(wires[0].raw).toContain("First synthetic request 580")
        expect(wires[1].raw).toContain("Synthetic answer 580")
        expect(wires[1].raw).toContain("Second synthetic request 580")
        expect(wires[2].raw).toContain("lookup")
        expect(wires[3].raw).toContain("synthetic-580")
        // Check only after capturing round four, so a lost extension still has
        // complete first/history/tool/continuation evidence for the matrix.
        expect(third.reasoning).toBe(reason)
        if (supplier.id === "doubao")
          expect(wires[3].raw).toContain('"encrypted_content":"synthetic-encrypted-doubao-580"')
        if (supplier.protocol === "responses") {
          expect(wires[3].body).toMatchObject({
            input: expect.arrayContaining([
              {
                type: "reasoning",
                summary: [{ type: "summary_text", text: reason }],
                encrypted_content: "synthetic-encrypted-580",
              },
              expect.objectContaining({ type: "function_call", call_id: "call_580", name: "lookup" }),
              expect.objectContaining({ type: "function_call_output", call_id: "call_580" }),
            ]),
          })
        } else if (supplier.protocol === "anthropic") {
          expect(wires[3].raw).toContain('"signature":"sig_580"')
          expect(wires[3].raw).toContain('"tool_use_id":"call_580"')
        } else if (supplier.protocol === "gemini") {
          expect(wires[3].raw).toContain('"thoughtSignature":"sig_thought_580"')
          expect(wires[3].raw).toContain('"thoughtSignature":"sig_tool_580"')
          expect(wires[3].raw).toContain('"functionResponse"')
        } else if (supplier.protocol === "openrouter") {
          expect(wires[3].raw).toContain('"reasoning_details"')
          expect(wires[3].raw).toContain('"signature":"sig_580"')
        } else {
          expect(wires[3].raw).toContain('"reasoning_content":"Synthetic reasoning 580"')
          expect(wires[3].raw).toContain('"tool_call_id":"call_580"')
        }
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            await server.stop(true)
            if (!process.env.ZAOVRA_MATRIX_DIR) return
            const output = `${process.env.ZAOVRA_MATRIX_DIR}/${supplier.id}.json`
            await Bun.write(
              output,
              JSON.stringify(
                {
                  supplier,
                  realModelCalls: 0,
                  listenerStopped: true,
                  // Archive afresh from authoritative HTTP bytes, independently
                  // of assertions that inspect the mutable parsed body.
                  wires: wires.map((wire) => ({ ...wire, body: JSON.parse(wire.raw) })),
                },
                null,
                2,
              ),
            )
          }),
        ),
      )
    }),
  )
}
