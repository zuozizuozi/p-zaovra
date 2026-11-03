import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../src"
import { AnthropicMessages, Gemini, OpenAIChat } from "../src/protocols"
import { AmazonBedrock } from "../src/providers"
import { ToolSchemaProjection } from "../src/protocols/utils/tool-schema"
import { Auth, LLMClient } from "../src/route"
import { it } from "./lib/effect"

describe("tool schema projections", () => {
  test("object root merges branch enums and keeps only shared required fields without mutating the input", () => {
    const input = {
      anyOf: [
        {
          type: "object",
          properties: {
            action: { type: "string", enum: ["open"] },
            value: { type: "string" },
            common: { type: "boolean" },
          },
          required: ["action", "value"],
        },
        {
          type: "object",
          properties: { action: { const: "press" }, value: { type: "number" }, common: { type: "boolean" } },
          required: ["action"],
        },
        { type: "object", properties: { action: { type: "string", enum: ["press", "close"] } }, required: ["action"] },
      ],
    }
    const before = JSON.stringify(input)
    expect(ToolSchemaProjection.objectRoot(input)).toEqual({
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "press", "close"] },
        value: { anyOf: [{ type: "string" }, { type: "number" }] },
        common: { type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    })
    expect(JSON.stringify(input)).toBe(before)
  })

  test("object root does not invent required fields or discard constraints on overlapping properties", () => {
    expect(
      ToolSchemaProjection.objectRoot({
        anyOf: [
          { type: "object", properties: { value: { type: "string", minLength: 2 } }, required: ["value"] },
          { type: "object", properties: { value: { type: "string", pattern: "^x" } } },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: {
        value: {
          anyOf: [
            { type: "string", minLength: 2 },
            { type: "string", pattern: "^x" },
          ],
        },
      },
      additionalProperties: false,
    })
  })

  test("moonshot strips $ref siblings and converts tuple arrays to a schema object", () => {
    expect(
      ToolSchemaProjection.moonshot({
        type: "object",
        properties: {
          linked: { $ref: "#/$defs/Linked", description: "drop me" },
          tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
          prefixTuple: { type: "array", prefixItems: [{ type: "boolean" }, { type: "string" }] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        linked: { $ref: "#/$defs/Linked" },
        tuple: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        prefixTuple: { type: "array", items: { anyOf: [{ type: "boolean" }, { type: "string" }] } },
      },
    })
  })

  test("gemini handles numeric enums, dangling required fields, untyped arrays, and scalar object keys", () => {
    expect(
      ToolSchemaProjection.gemini({
        type: "object",
        required: ["status", "missing"],
        properties: {
          status: { type: "integer", enum: [1, 2] },
          tags: { type: "array" },
          name: { type: "string", properties: { ignored: { type: "string" } }, required: ["ignored"] },
        },
      }),
    ).toEqual({
      type: "object",
      required: ["status"],
      properties: {
        status: { type: "string", enum: ["1", "2"] },
        tags: { type: "array", items: { type: "string" } },
        name: { type: "string" },
      },
    })
  })

  test("object root keeps one flat object top-level schema", () => {
    expect(
      ToolSchemaProjection.objectRoot({
        anyOf: [
          {
            type: "object",
            properties: {
              path: { type: "string" },
              maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
          },
          { type: "object", properties: { resource: { type: "string" } } },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        maybe: { type: "string" },
        resource: { type: "string" },
      },
      additionalProperties: false,
    })
  })

  it.effect("applies model compatibility before protocol projection", () =>
    Effect.gen(function* () {
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
        .model({ id: "kimi-k2", compatibility: { toolSchema: "moonshot" } })
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          prompt: "Use the tool.",
          tools: [
            {
              name: "lookup",
              description: "Lookup data.",
              inputSchema: {
                type: "object",
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      tuple: { type: "array", items: [{ type: "string" }, { type: "number" }] },
                      linked: { $ref: "#/$defs/Linked", description: "drop me" },
                    },
                  },
                ],
              },
            },
          ],
        }),
      )

      expect(prepared.body.tools?.[0]?.function.parameters).toEqual({
        type: "object",
        properties: {
          tuple: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
          linked: { $ref: "#/$defs/Linked" },
        },
        additionalProperties: false,
      })
    }),
  )

  // Effect emits root unions for Schema.Union inputs (browser) and `Schema.Struct({})` (task_list).
  const rootUnionTools = [
    {
      name: "browser",
      description: "Browse.",
      inputSchema: {
        anyOf: [
          {
            type: "object",
            properties: { action: { type: "string", enum: ["open"] }, url: { type: "string" } },
            required: ["action", "url"],
          },
          { type: "object", properties: { action: { type: "string", enum: ["close"] } }, required: ["action"] },
        ],
      },
    },
    { name: "task_list", description: "List tasks.", inputSchema: { anyOf: [{ type: "object" }, { type: "array" }] } },
  ]

  it.effect("anthropic lowers root unions to object input_schema", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<AnthropicMessages.AnthropicMessagesBody>(
        LLM.request({
          model: AnthropicMessages.route
            .with({ endpoint: { baseURL: "https://api.anthropic.test/v1/" }, auth: Auth.header("x-api-key", "test") })
            .model({ id: "claude-haiku-5-5" }),
          prompt: "Use the tool.",
          tools: rootUnionTools,
        }),
      )
      expect(prepared.body.tools?.map((tool) => tool.input_schema)).toEqual([
        {
          type: "object",
          properties: { action: { type: "string", enum: ["open", "close"] }, url: { type: "string" } },
          required: ["action"],
          additionalProperties: false,
        },
        { type: "object", properties: {}, additionalProperties: false },
      ])
    }),
  )

  it.effect("bedrock lowers root unions to object inputSchema", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<{
        toolConfig: { tools: { toolSpec?: { inputSchema: { json: unknown } } }[] }
      }>(
        LLM.request({
          model: AmazonBedrock.configure({ baseURL: "https://bedrock-runtime.test", apiKey: "test" }).model(
            "anthropic.claude-haiku-5-5",
          ),
          prompt: "Use the tool.",
          tools: rootUnionTools,
        }),
      )
      expect(
        prepared.body.toolConfig.tools.flatMap((tool) => (tool.toolSpec ? [tool.toolSpec.inputSchema.json] : [])),
      ).toMatchObject([{ type: "object" }, { type: "object" }])
    }),
  )

  it.effect("gemini inlines $defs, folds allOf and keeps object root parameters", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<Gemini.GeminiBody>(
        LLM.request({
          model: Gemini.route
            .with({ endpoint: { baseURL: "https://gemini.test/v1beta/" }, auth: Auth.header("x-goog-api-key", "test") })
            .model({ id: "gemini-3-flash" }),
          prompt: "Use the tool.",
          tools: [
            ...rootUnionTools,
            {
              name: "todowrite",
              description: "Write todos.",
              inputSchema: {
                type: "object",
                properties: {
                  todos: { type: "array", items: { $ref: "#/$defs/Todo" } },
                  timeout: { anyOf: [{ type: "integer", allOf: [{ exclusiveMinimum: 0 }] }, { type: "null" }] },
                  mode: { oneOf: [{ type: "string" }, { type: "number" }] },
                },
                required: ["todos"],
                $defs: {
                  Todo: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
                },
              },
            },
          ],
        }),
      )
      expect(prepared.body.tools?.[0]?.functionDeclarations.map((tool) => tool.parameters)).toEqual([
        {
          type: "object",
          required: ["action"],
          properties: { action: { type: "string", enum: ["open", "close"] }, url: { type: "string" } },
        },
        undefined,
        {
          type: "object",
          required: ["todos"],
          properties: {
            todos: {
              type: "array",
              items: { type: "object", required: ["content"], properties: { content: { type: "string" } } },
            },
            timeout: { type: "integer" },
            mode: { anyOf: [{ type: "string" }, { type: "number" }] },
          },
        },
      ])
    }),
  )
})
