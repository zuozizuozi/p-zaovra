import { describe, expect, it } from "bun:test"
import type { ZaovraClient } from "@zaovra-ai/sdk/v2"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { ModelV2 } from "@zaovra-ai/core/model"
import { Effect } from "effect"
import { make } from "@/acp/service"
import { Directory } from "@/acp/directory"
import { UnsupportedOperationError } from "@/acp/error"

const snapshot: Directory.Snapshot = {
  directory: "/workspace",
  providers: {},
  modelOptions: [],
  variantsByModel: {},
  availableModes: [{ id: "build", name: "build" }],
  defaultModeID: "build",
  availableCommands: [{ name: "init", description: "Initialize", source: "command", template: "", hints: [] }],
  defaultModel: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
}

function makeService() {
  const calls: string[] = []
  const assistant = {
    id: "msg_assistant",
    type: "assistant" as const,
    agent: "build",
    model: { providerID: "test", id: "model" },
    time: { created: 2, completed: 3 },
    content: [{ id: "text_1", type: "text" as const, text: "done" }],
    finish: "stop",
    cost: 0.25,
    tokens: { input: 5, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
  }
  const sdk = {
    v2: {
      session: {
        create: () => {
          calls.push("create")
          return Promise.resolve({
            data: {
              data: {
                id: "ses_v2",
                projectID: "project",
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: 1, updated: 1 },
                title: "Session",
                location: { directory: "/workspace" },
              },
            },
          })
        },
        switchAgent: () => {
          calls.push("switchAgent")
          return Promise.resolve({ data: undefined })
        },
        switchModel: () => {
          calls.push("switchModel")
          return Promise.resolve({ data: undefined })
        },
        prompt: () => {
          calls.push("prompt")
          return Promise.resolve({ data: { data: { id: "input", sessionID: "ses_v2", timeCreated: 1 } } })
        },
        active: () => Promise.resolve({ data: { data: {} } }),
        pendingInputs: () => Promise.resolve({ data: { data: [] } }),
        messages: () => Promise.resolve({ data: { data: [assistant] } }),
      },
    },
  } as unknown as ZaovraClient
  const directory = Directory.Service.of({
    get: () => Effect.succeed(snapshot),
    refresh: () => Effect.succeed(snapshot),
    variants: Directory.variants,
  })
  return { calls, service: make({ sdk, directory }) }
}

describe("ACP V2 session transport", () => {
  it("creates, prompts, polls completion, and returns projected usage", async () => {
    const { calls, service } = makeService()
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const result = await Effect.runPromise(
      service.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hello" }] }),
    )

    expect(created.sessionId).toBe("ses_v2")
    expect(calls).toEqual(["create", "switchAgent", "switchModel", "prompt"])
    expect(result).toMatchObject({
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 3, thoughtTokens: 1, cachedReadTokens: 2, totalTokens: 11 },
    })
  })

  it("rejects fork, slash commands, summarize, and MCP registration explicitly", async () => {
    const { service } = makeService()
    const created = await Effect.runPromise(service.newSession({ cwd: "/workspace", mcpServers: [] }))
    const methods = await Promise.all([
      Effect.runPromise(service.forkSession({ cwd: "/workspace", sessionId: created.sessionId }).pipe(Effect.flip)),
      Effect.runPromise(
        service
          .prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "/init" }] })
          .pipe(Effect.flip),
      ),
      Effect.runPromise(
        service
          .prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "/compact" }] })
          .pipe(Effect.flip),
      ),
      Effect.runPromise(
        service
          .newSession({ cwd: "/workspace", mcpServers: [{ name: "tools", command: "node", args: [], env: [] }] })
          .pipe(Effect.flip),
      ),
    ])

    expect(methods.map((error) => (error as UnsupportedOperationError).method)).toEqual([
      "session/fork",
      "session/command",
      "session/summarize",
      "mcp/add",
    ])
  })
})
