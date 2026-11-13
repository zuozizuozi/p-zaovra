import { expect } from "bun:test"
import { LLM, ToolDefinition } from "@zaovra-ai/llm"
import type { OpenAIChatBody } from "@zaovra-ai/llm/protocols/openai-chat"
import { LLMClient } from "@zaovra-ai/llm/route"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionRunnerModel } from "@zaovra-ai/core/session/runner/model"
import { toLLMMessages } from "@zaovra-ai/core/session/runner/to-llm-message"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { DateTime, Effect, Exit } from "effect"
import { it } from "./lib/effect"

const created = DateTime.makeUnsafe(0)
const modelID = ModelV2.ID.make("deepseek-v4.1-flash")
const providerID = ProviderV2.ID.make("gravitex")
const session = SessionV2.Info.make({
  id: SessionV2.ID.make("ses_deepseek_history"),
  projectID: ProjectV2.ID.global,
  title: "Synthetic history",
  model: { id: modelID, providerID, variant: ModelV2.VariantID.make("fixture") },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created, updated: created },
  location: { directory: AbsolutePath.make("/project") },
})

for (const fixture of [
  { name: "same model thinking history", reasoning: "original reasoning", calls: true, allowed: true },
  { name: "changed DeepSeek model", reasoning: "private old reasoning", model: "deepseek-other", calls: true },
  { name: "changed provider", reasoning: "private old reasoning", provider: "other", calls: true },
  { name: "new non-thinking turn before re-enabling", calls: true },
  { name: "no tools negative control", tools: false, calls: true, allowed: true },
  { name: "no historical calls with tools now", reasoning: "original reasoning", allowed: true },
  { name: "changed model without historical calls", reasoning: "private old reasoning", model: "deepseek-other" },
  { name: "thinking disabled", disabled: true, calls: true, allowed: true },
  { name: "toggle without a new assistant", reasoning: "original reasoning", calls: true, allowed: true },
  { name: "empty reasoning is not a substitute", reasoning: "", calls: true },
]) {
  it.effect(`192 runner history: ${fixture.name}`, () =>
    Effect.gen(function* () {
      const model = yield* SessionRunnerModel.resolve(
        session,
        ModelV2.Info.make({
          id: modelID,
          providerID,
          name: "DeepSeek fixture",
          api: {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://synthetic.invalid/v1",
            id: modelID,
          },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          request: { headers: {}, body: {} },
          variants: [
            {
              id: ModelV2.VariantID.make("fixture"),
              headers: {},
              body: { thinking: { type: fixture.disabled ? "disabled" : "enabled" } },
            },
          ],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 1000000, output: 32000 },
        }),
      )
      const history = [
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_history"),
          type: "assistant",
          agent: "build",
          model: {
            id: ModelV2.ID.make(fixture.model ?? modelID),
            providerID: ProviderV2.ID.make(fixture.provider ?? providerID),
          },
          time: { created, completed: created },
          content: [
            ...(fixture.reasoning === undefined
              ? []
              : [
                  SessionMessage.AssistantReasoning.make({
                    type: "reasoning",
                    id: "reasoning-0",
                    text: fixture.reasoning,
                    time: { created, completed: created },
                  }),
                ]),
            SessionMessage.AssistantText.make({
              type: "text",
              id: "text-0",
              text: "Read finished",
            }),
            ...(fixture.calls
              ? [
                  SessionMessage.AssistantTool.make({
                    type: "tool",
                    id: "read-1",
                    name: "read",
                    time: { created, completed: created },
                    state: {
                      status: "completed",
                      input: { path: "fixture.txt" },
                      content: [{ type: "text", text: "retained tool result" }],
                      structured: {},
                    },
                  }),
                ]
              : []),
          ],
        }),
      ]
      const original = JSON.stringify(history)
      const messages = toLLMMessages(history, model)
      const result = yield* LLMClient.prepare<OpenAIChatBody>(
        LLM.request({
          model,
          messages,
          tools:
            fixture.tools === false
              ? []
              : [
                  ToolDefinition.make({
                    name: "read",
                    description: "Read synthetic fixture",
                    inputSchema: { type: "object" },
                  }),
                ],
        }),
      ).pipe(Effect.exit)
      expect(JSON.stringify(history)).toBe(original)
      if (!fixture.allowed) {
        // The API refuses thinking mode with tools unless every earlier turn carries its reasoning,
        // so the request goes out with thinking off instead of failing the conversation.
        if (Exit.isFailure(result)) throw new Error(String(result.cause))
        expect(result.value.body.thinking).toEqual({ type: "disabled" })
        expect(result.value.body.reasoning_effort).toBeUndefined()
        if (fixture.calls) expect(JSON.stringify(result.value.body.messages)).toContain("retained tool result")
        return
      }
      if (Exit.isFailure(result)) throw new Error(String(result.cause))
      const assistant = result.value.body.messages.find((message) => message.role === "assistant")
      expect(assistant?.reasoning_content).toBe(fixture.reasoning)
      if (fixture.calls) {
        expect(assistant?.tool_calls?.map((call) => call.id)).toEqual(["read-1"])
        expect(result.value.body.messages.find((message) => message.role === "tool")).toMatchObject({
          tool_call_id: "read-1",
          content: "retained tool result",
        })
      }
    }),
  )
}
