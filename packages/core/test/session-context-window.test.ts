import { expect, test } from "bun:test"
import { LLM, Message, Model, SystemPart, ToolDefinition, Usage } from "@zaovra-ai/llm"
import { OpenAICompatibleChat } from "@zaovra-ai/llm/protocols/openai-compatible-chat"
import { SessionContextWindow } from "../src/session/context-window"

const model = Model.make({
  id: "paired",
  provider: "offline",
  route: OpenAICompatibleChat.route.with({ limits: { context: 128000, output: 4096 } }),
})
const request = LLM.request({ model, prompt: "Original request", system: [SystemPart.make("Host context")] })
const usage = Usage.from({
  inputTokens: 50000,
  cacheReadInputTokens: 40000,
  cacheWriteInputTokens: 10000,
  outputTokens: 900000,
  totalTokens: 950000,
})

test("K55 uses one request's inclusive input count, without cumulative output or duplicate cache tokens", () => {
  const window = SessionContextWindow.make()
  window.start(request, 1)(usage)
  expect(window.estimate(request, 1)).toEqual({ tokens: 50000, source: "reported-plus-delta" })
  const next = LLM.updateRequest(request, {
    messages: [...request.messages, Message.assistant("New result"), Message.user("Continue")],
  })
  expect(window.estimate(next, 1).tokens).toBeGreaterThan(50000)
  expect(window.estimate(next, 1).tokens).toBeLessThan(51000)
})

test("K55 counts added tools, schemas, host context and media without deleting request content", () => {
  const variants = [
    LLM.updateRequest(request, {
      tools: [
        new ToolDefinition({
          name: "fixture",
          description: "Added capability",
          inputSchema: {
            type: "object",
            properties: { payload: { type: "string", description: "schema ".repeat(500) } },
          },
          outputSchema: { type: "object" },
        }),
      ],
    }),
    LLM.updateRequest(request, { system: [...request.system, SystemPart.make("Added host context ".repeat(500))] }),
    LLM.updateRequest(request, {
      messages: [
        ...request.messages,
        Message.make({
          role: "user",
          content: [{ type: "media", mediaType: "image/png", data: "data:image/png;base64," + "A".repeat(4000) }],
        }),
      ],
    }),
  ]
  for (const next of variants) {
    const before = JSON.stringify(next)
    const window = SessionContextWindow.make()
    window.start(request, "epoch")(usage)
    expect(window.estimate(next, "epoch").tokens).toBeGreaterThan(50000)
    expect(JSON.stringify(next)).toBe(before)
    expect(SessionContextWindow.estimateInput(next)).toBeGreaterThan(SessionContextWindow.estimateInput(request))
  }
})

test("K55 missing, partial or invalid input usage invalidates the last pair, including late settlement", () => {
  for (const reported of [
    undefined,
    Usage.from({ outputTokens: 100 }),
    Usage.from({ inputTokens: 0 }),
    Usage.from({ inputTokens: -1 }),
    Usage.from({ inputTokens: 10, cacheReadInputTokens: 11 }),
  ]) {
    const window = SessionContextWindow.make()
    window.start(request, 1)(usage)
    const finish = window.start(request, 1)
    finish(reported)
    finish(usage)
    expect(window.estimate(request, 1).source).toBe("estimate")
    expect(window.estimate(request, 1).tokens).not.toBe(50000)
  }
})

test("K55 stale requests and stale epochs cannot install late usage over the current pair", () => {
  const window = SessionContextWindow.make()
  const old = window.start(request, 1)
  const next = LLM.updateRequest(request, { messages: [...request.messages, Message.user("Next input")] })
  const current = window.start(next, 1)
  old(usage)
  expect(window.estimate(next, 1).source).toBe("estimate")
  current(Usage.from({ inputTokens: 200 }))
  old(usage)
  expect(window.estimate(next, 1).tokens).toBe(200)
  const pending = window.start(next, 1)
  expect(window.estimate(next, 2).source).toBe("estimate")
  pending(usage)
  expect(window.estimate(next, 2).source).toBe("estimate")
})

test("K55 model, provider, route, context epoch and restart rebuild the input baseline", () => {
  for (const changed of [
    Model.make({ ...model, id: "other" }),
    Model.make({ ...model, provider: "other" }),
    Model.make({ ...model, route: model.route.with({ endpoint: { baseURL: "https://offline.invalid/other" } }) }),
    Model.make({ ...model, route: model.route.with({ limits: { context: 64000 } }) }),
  ]) {
    const window = SessionContextWindow.make()
    window.start(request, "system/compaction-1")(usage)
    expect(window.estimate(LLM.updateRequest(request, { model: changed }), "system/compaction-1").source).toBe(
      "estimate",
    )
  }
  const window = SessionContextWindow.make()
  window.start(request, "system/compaction-1")(usage)
  expect(window.estimate(request, "system/compaction-2").source).toBe("estimate")
  expect(SessionContextWindow.make().estimate(request, "system/compaction-1").source).toBe("estimate")
})
