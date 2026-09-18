import { describe, expect, test } from "bun:test"
import { LLM, Model } from "@zaovra-ai/llm"
import { OpenAIChat } from "@zaovra-ai/llm/protocols/openai-chat"
import { SessionOutputRecovery } from "@zaovra-ai/core/session/output-recovery"

const request = (context?: number, output?: number, maxTokens?: number) =>
  LLM.request({
    model: Model.make({
      id: "arbitrary-model",
      provider: "arbitrary-provider",
      route: OpenAIChat.route.with({
        limits: { context, output },
        generation: { maxTokens },
      }),
    }),
    prompt: "Do the task",
  })
const plan = (value: ReturnType<typeof request>, attempts = 0) =>
  SessionOutputRecovery.plan({
    request: value,
    attempts,
    outputTokens: 16000,
    inputTokens: 100,
  })

describe("SessionOutputRecovery budgets", () => {
  test("pending recovery identifies the exact gateway and model configuration", () => {
    const original = request(200000, 64000)
    const other = Model.make({
      ...original.model,
      route: OpenAIChat.route.with({ endpoint: { baseURL: "https://other.test" } }),
    })
    expect(SessionOutputRecovery.identity(original.model)).not.toBe(SessionOutputRecovery.identity(other))
    expect(SessionOutputRecovery.identity(original.model)).toBe(SessionOutputRecovery.identity(original.model))
  })
  test("unknown capacity keeps the provider default and allows only one smaller step", () => {
    expect(plan(request())).toEqual({ strategy: "smaller-step", maxTokens: undefined })
    expect(plan(request(), 1)).toBeUndefined()
  })
  test("known capacity permits a larger next request without a model-name heuristic", () => {
    expect(plan(request(200000, 64000))).toEqual({ strategy: "increase-output", maxTokens: 32000 })
  })
  test("explicit request ceilings cannot be exceeded", () => {
    expect(plan(request(200000, 64000, 16000))).toEqual({ strategy: "smaller-step", maxTokens: 16000 })
  })
  test("missing context capacity prevents automatic expansion", () => {
    expect(plan(request(undefined, 64000))).toEqual({ strategy: "smaller-step", maxTokens: undefined })
  })
  test("reported input and output reserve constrain expansion", () => {
    expect(plan(request(40000, 64000))).toEqual({ strategy: "increase-output", maxTokens: 19804 })
  })
  test("two consecutive adjustments exhaust the recovery allowance", () => {
    expect(plan(request(200000, 64000), 2)).toBeUndefined()
  })
  test("reloaded policy and context never produce a zero-token request", () => {
    expect(SessionOutputRecovery.budget(request(100, 64000), undefined, 32000)).toBeUndefined()
    expect(SessionOutputRecovery.budget(request(100, 64000, 16000), undefined, 32000)).toBe(16000)
  })
  test("a policy is clamped by both model capacity and an explicit hard ceiling", () => {
    expect(SessionOutputRecovery.budget(request(200000, 32000, 8000), { initial: 16000, maximum: 64000 })).toBe(8000)
  })
})
