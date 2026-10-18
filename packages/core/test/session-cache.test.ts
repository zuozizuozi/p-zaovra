import { expect, test } from "bun:test"
import { LLM, Message, Model, Usage, ToolDefinition } from "@zaovra-ai/llm"
import { OpenAICompatibleChat } from "@zaovra-ai/llm/protocols/openai-compatible-chat"
import { SessionCache } from "../src/session/cache"

const model = Model.make({ id: "fixture", provider: "fixture", route: OpenAICompatibleChat.route })
const request = LLM.request({ model, system: "Stable rules", messages: [Message.user("original task")] })

test("K2 usage reports separate response snapshots, fingerprints and unknown versions", () => {
  const versions = [
    { responseModel: "1016", systemFingerprint: "a" },
    { responseModel: "1017", systemFingerprint: "a" },
    { responseModel: "1017", systemFingerprint: "b" },
    {},
  ]
  const rows = versions.flatMap((version, index) => [
    {
      seq: index * 2,
      data: {
        category: "cache",
        details: { phase: "request", requestID: `request-${index}`, reason: "first", firstChanged: null },
      },
    },
    {
      seq: index * 2 + 1,
      data: {
        category: "cache",
        details: {
          phase: "usage",
          requestID: `request-${index}`,
          ...SessionCache.usage(new Usage({ inputTokens: 10, outputTokens: 2 })),
          ...version,
        },
      },
    },
  ])
  const report = SessionCache.report(rows)!
  expect(report.versions).toHaveLength(4)
  expect(report.versions?.map((item) => [item.responseModel, item.systemFingerprint, item.calls, item.total])).toEqual([
    ["1016", "a", 1, 12],
    ["1017", "a", 1, 12],
    ["1017", "b", 1, 12],
    [null, null, 1, 12],
  ])
  expect(report.points[0].responseModel).toBe("1016")
})

test("K1 tool ordering and nested JSON keys are deterministic", () => {
  const first = [
    ToolDefinition.make({
      name: "z",
      description: "z",
      inputSchema: { type: "object", properties: { b: { type: "number" }, a: { type: "string" } } },
    }),
    ToolDefinition.make({ name: "a", description: "a", inputSchema: {} }),
  ]
  const next = [
    first[1],
    ToolDefinition.make({
      name: "z",
      description: "z",
      inputSchema: { properties: { a: { type: "string" }, b: { type: "number" } }, type: "object" },
    }),
  ]
  expect(JSON.stringify(SessionCache.tools(first))).toBe(JSON.stringify(SessionCache.tools(next)))
})

test("K1 prefix hashes locate system time changes and preserve append-only history", () => {
  const first = SessionCache.snapshot(request, 1)
  const next = SessionCache.snapshot(
    LLM.updateRequest(request, { messages: [...request.messages, Message.assistant("result")] }),
    1,
  )
  expect(SessionCache.compare(first, next)).toMatchObject({ reason: "append", firstChanged: null })
  const changed = SessionCache.snapshot(LLM.updateRequest(request, { system: "Stable rules; time=123" }), 1)
  expect(SessionCache.compare(first, changed)).toMatchObject({ reason: "system", firstChanged: "system" })
  expect(SessionCache.compare(first, SessionCache.snapshot(request, 2)).reason).toBe("compaction")
  expect(
    SessionCache.compare(
      first,
      SessionCache.snapshot(LLM.updateRequest(request, { model: Model.update(model, { id: "other" }) }), 1),
    ).reason,
  ).toBe("model")
  expect(JSON.stringify(first)).not.toContain("original task")
  expect(JSON.stringify(first)).not.toContain("Stable rules")
})

test("K1 cache usage preserves missing breakdown as unknown and exposes disjoint output", () => {
  expect(SessionCache.usage(undefined)).toMatchObject({
    hit: null,
    miss: null,
    hitRate: null,
    visible: null,
    reasoning: null,
  })
  expect(SessionCache.usage(new Usage({ inputTokens: 100, outputTokens: 30 }))).toMatchObject({
    input: 100,
    output: 30,
    hit: null,
    hitRate: null,
    visible: null,
    reasoning: null,
  })
  expect(
    SessionCache.usage(
      new Usage({
        inputTokens: 100,
        outputTokens: 30,
        cacheReadInputTokens: 80,
        nonCachedInputTokens: 20,
        reasoningTokens: 24,
      }),
    ),
  ).toMatchObject({ hit: 80, miss: 20, hitRate: 0.8, visible: 6, reasoning: 24, total: 130 })
})

test("K1 session report exposes the hit-rate curve and interruption as unknown", () => {
  const report = SessionCache.report([
    {
      seq: 1,
      data: { category: "cache", details: { phase: "request", requestID: "r1", reason: "first", firstChanged: null } },
    },
    {
      seq: 2,
      data: {
        category: "cache",
        details: {
          phase: "usage",
          requestID: "r1",
          ...SessionCache.usage(
            new Usage({
              inputTokens: 100,
              outputTokens: 20,
              cacheReadInputTokens: 90,
              nonCachedInputTokens: 10,
              reasoningTokens: 5,
            }),
          ),
        },
      },
    },
    {
      seq: 3,
      data: {
        category: "cache",
        details: { phase: "request", requestID: "r2", reason: "system", firstChanged: "system" },
      },
    },
  ])
  expect(report?.points.map((point) => point.hitRate)).toEqual([0.9, null])
  expect(report?.breaks).toEqual([{ reason: "system", count: 1 }])
  expect(report?.points[1]?.output).toBeNull()
})
