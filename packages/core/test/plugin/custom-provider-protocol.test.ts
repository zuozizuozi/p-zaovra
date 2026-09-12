import { test, expect } from "bun:test"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { ConfigMigrateV1 } from "@zaovra-ai/core/v1/config/migrate"
import { validateCustomProvider } from "../../../app-ui/src/components/dialog-custom-provider-form"

for (const protocol of ["openai", "anthropic", "google"] as const) {
  test(protocol + " form configuration reaches its real SDK wire protocol", async () => {
    const requests: { path: string; headers: Headers }[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        requests.push({ path: new URL(request.url).pathname, headers: request.headers })
        if (protocol === "anthropic")
          return Response.json({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "example",
            content: [{ type: "text", text: "connected" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          })
        if (protocol === "google")
          return Response.json({
            candidates: [
              { content: { role: "model", parts: [{ text: "connected" }] }, finishReason: "STOP", index: 0 },
            ],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          })
        return Response.json({
          id: "chat_test",
          object: "chat.completion",
          created: 1,
          model: "example",
          choices: [{ index: 0, message: { role: "assistant", content: "connected" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    })
    try {
      const result = validateCustomProvider({
        form: {
          protocol,
          providerID: "custom",
          name: "Custom",
          baseURL: server.url.origin,
          apiKey: "test-only",
          models: [{ row: "m", id: "example", name: "Example", err: {} }],
          headers: [],
          err: {},
        },
        t: (key) => key,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      }).result!
      const migrated = ConfigMigrateV1.migrate({ provider: { custom: result.config } }).providers!.custom!
      expect(migrated.api?.package).toBe(result.config.npm)
      const factory = {
        "@ai-sdk/openai-compatible": createOpenAICompatible,
        "@ai-sdk/anthropic": createAnthropic,
        "@ai-sdk/google": createGoogleGenerativeAI,
      }[result.config.npm]
      const sdk = factory({ name: "custom", baseURL: migrated.api!.url!, apiKey: result.key })
      const response = await sdk
        .languageModel("example")
        .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }], maxOutputTokens: 16 })
      expect(
        response.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      ).toBe("connected")
      expect(requests).toHaveLength(1)
      expect(requests[0].path).toBe(
        protocol === "google"
          ? "/v1beta/models/example:generateContent"
          : protocol === "anthropic"
            ? "/v1/messages"
            : "/v1/chat/completions",
      )
      expect(
        requests[0].headers.get(
          protocol === "google" ? "x-goog-api-key" : protocol === "anthropic" ? "x-api-key" : "authorization",
        ),
      ).toBe(protocol === "openai" ? "Bearer test-only" : "test-only")
      if (protocol !== "openai") expect(requests[0].headers.has("authorization")).toBe(false)
    } finally {
      server.stop(true)
    }
  })
}
