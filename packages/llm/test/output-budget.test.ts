import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Model } from "../src"
import { Auth, LLMClient } from "../src/route"
import { OpenAIChat } from "../src/protocols/openai-chat"
import { OpenAICompatibleChat } from "../src/protocols/openai-compatible-chat"
import { OpenAIResponses } from "../src/protocols/openai-responses"
import { AnthropicMessages } from "../src/protocols/anthropic-messages"
import { Gemini } from "../src/protocols/gemini"
import { BedrockConverse } from "../src/protocols/bedrock-converse"
import { it } from "./lib/effect"

for (const [route, expected] of [
  [OpenAIChat.route, { max_tokens: 32000 }],
  [OpenAICompatibleChat.route, { max_tokens: 32000 }],
  [OpenAIResponses.route, { max_output_tokens: 32000 }],
  [AnthropicMessages.route, { max_tokens: 32000 }],
  [Gemini.route, { generationConfig: { maxOutputTokens: 32000 } }],
  [BedrockConverse.route, { inferenceConfig: { maxTokens: 32000 } }],
] as const) {
  it.effect(`serializes an adjusted output budget through ${route.id}`, () =>
    Effect.gen(function* () {
      const request = LLM.request({
        model: Model.make({
          provider: "test",
          id: "arbitrary-model",
          route: route.with({ auth: Auth.bearer("fixture-only"), endpoint: { baseURL: "https://example.test" } }),
        }),
        prompt: "Keep the original task",
        generation: { maxTokens: 16000 },
      })
      const adjusted = LLM.updateRequest(request, { generation: { maxTokens: 32000 } })
      const prepared = yield* LLMClient.prepare(adjusted)
      expect(prepared.body).toMatchObject(expected)
      expect(adjusted.messages).toEqual(request.messages)
      expect(adjusted.providerOptions).toEqual(request.providerOptions)
    }),
  )
}
