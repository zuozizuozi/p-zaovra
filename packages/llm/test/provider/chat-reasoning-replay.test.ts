import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message } from "../../src"
import { OpenAICompatible } from "../../src/providers"
import type { OpenAIChatBody } from "../../src/protocols/openai-chat"
import { LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { fixedResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const model = OpenAICompatible.configure({ baseURL: "https://synthetic.invalid/v1", apiKey: "synthetic" }).model(
  "fixture",
)

for (const fixture of [
  { name: "ciphertext without summary", deltas: [{ encrypted_content: "opaque" }], encrypted: "opaque", text: "" },
  {
    name: "ciphertext chunks after visible text",
    deltas: [
      { reasoning_content: "summary" },
      { content: "answer" },
      { encrypted_content: "opaque-" },
      { encrypted_content: "tail" },
    ],
    encrypted: "opaque-tail",
    text: "summary",
  },
  { name: "LM Studio alias", deltas: [{ reasoning: "summary" }], encrypted: undefined, text: "summary" },
  {
    name: "alias alongside empty canonical delta",
    deltas: [{ reasoning_content: "", reasoning: "summary" }],
    encrypted: undefined,
    text: "summary",
  },
  {
    name: "canonical reasoning wins over alias without duplication",
    deltas: [{ reasoning_content: "canonical", reasoning: "alias" }],
    encrypted: undefined,
    text: "canonical",
  },
  { name: "absent ciphertext stays absent", deltas: [{ content: "answer" }], encrypted: undefined, text: "" },
]) {
  it.effect(`587 Chat replay: ${fixture.name}`, () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "synthetic" })).pipe(
        Effect.provide(
          fixedResponse(
            sseEvents(...fixture.deltas.map((delta) => ({ choices: [{ delta }] })), {
              choices: [{ delta: {}, finish_reason: "stop" }],
            }),
          ),
        ),
      )
      expect(response.reasoning).toBe(fixture.text)
      const prepared = yield* LLMClient.prepare<OpenAIChatBody>(
        LLM.request({
          model,
          messages: [Message.user("synthetic"), response.message, Message.user("continue")],
        }),
      )
      const assistant = prepared.body.messages.find((message) => message.role === "assistant")
      expect(assistant?.encrypted_content).toBe(fixture.encrypted)
      expect(assistant?.reasoning_content).toBe(
        fixture.encrypted === undefined ? fixture.text || undefined : fixture.text,
      )
    }),
  )
}
