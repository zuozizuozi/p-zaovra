import { describe, expect } from "bun:test"
import { Effect, Layer, LayerMap, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM, Message, ToolCallPart, type ToolDefinition } from "@zaovra-ai/llm"
import { LLMClient, RequestExecutor } from "@zaovra-ai/llm/route"
import { AmazonBedrock } from "@zaovra-ai/llm/providers"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { BuiltInTools } from "../src/tool/builtins"
import { BrowserTool } from "../src/tool/browser"
import { TaskTool } from "../src/tool/task"
import { ApplicationTools } from "../src/tool/application-tools"
import { Tool } from "../src/tool/tool"
import { MCP } from "../src/mcp"
import { SessionV2 } from "../src/session"
import { LocationServiceMap } from "../src/location-service-map"
import type { LocationError, LocationServices } from "../src/location-services"
import { ToolRegistry } from "../src/tool/registry"
import { PermissionV2 } from "../src/permission"
import { Config } from "../src/config"
import { ConfigMCP } from "../src/config/mcp"
import { Location } from "../src/location"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { SessionRunnerModel } from "../src/session/runner/model"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import openAIWire545 from "./fixture/provider-wire545.json"

// Real shipped registry (built-ins, Task, disconnected MCP) lowered by every
// catalog route through a local fixed HTTP server. No network, no real keys.
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([BuiltInTools.node, TaskTool.node, MCP.node, ToolRegistry.node, ApplicationTools.node]),
    [
      [Location.node, tempLocationLayer],
      [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
      [
        Config.node,
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: new Config.Info({
                    mcp: new ConfigMCP.Info({
                      servers: {
                        offline: new ConfigMCP.Remote({
                          type: "remote",
                          url: "https://offline.invalid",
                          disabled: true,
                        }),
                      },
                    }),
                  }),
                }),
              ]),
          }),
        ),
      ],
      [
        SessionV2.node,
        Layer.mock(SessionV2.Service, {
          revert: {
            plan: () => Effect.die("unused"),
            stage: () => Effect.die("unused"),
            clear: () => Effect.die("unused"),
            commit: () => Effect.die("unused"),
          },
        }),
      ],
      [
        LocationServiceMap.node,
        Layer.effect(
          LocationServiceMap.Service,
          LayerMap.make(
            (_ref: Location.Ref): Layer.Layer<LocationServices, LocationError> =>
              Layer.unwrap(Effect.die("No child execution in wire fixtures")),
          ),
        ),
      ],
    ],
  ),
)

const NAME = /^[a-zA-Z0-9_-]{1,64}$/
// Gemini FunctionDeclaration.parameters is the OpenAPI-subset Schema message;
// unknown field names are rejected by the API.
// https://ai.google.dev/api/caching#Schema
const GEMINI_FIELDS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "items",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
  "default",
])
const GEMINI_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"])

const routes = [
  { pkg: "@ai-sdk/anthropic", provider: "wanyin" },
  { pkg: "@ai-sdk/openai", provider: "openai-gateway" },
  { pkg: "@ai-sdk/openai-compatible", provider: "deepseek" },
  { pkg: "@ai-sdk/openai-compatible", provider: "moonshot" },
  { pkg: "@openrouter/ai-sdk-provider", provider: "openrouter" },
  { pkg: "@ai-sdk/google", provider: "google" },
] as const

describe("provider tool wire compatibility", () => {
  for (const route of routes)
    it.live(`${route.provider} (${route.pkg}) sends provider-valid schemas for every shipped tool`, () =>
      Effect.gen(function* () {
        const tools = yield* shippedTools()
        const body = yield* captureBody(route.pkg, route.provider, tools)
        const lowered = loweredTools(route.pkg, body)
        expect(lowered.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name))
        for (const tool of lowered) {
          const original = tools.find((definition) => definition.name === tool.name)!
          expect(tool.description).toBe(original.description)
          expect(descriptions(tool.schema)).toEqual(expect.arrayContaining(descriptions(original.inputSchema)))
          expect(tool.name).toMatch(NAME)
          if (route.pkg === "@ai-sdk/google") {
            expect(geminiViolations(tool.schema ?? { type: "object" }, tool.name)).toEqual([])
            continue
          }
          expect({ name: tool.name, type: tool.schema?.type }).toEqual({ name: tool.name, type: "object" })
        }
        const byName = Object.fromEntries(lowered.map((tool) => [tool.name, tool.schema]))
        expect(byName.read?.properties?.offset?.description).toBe(
          "The 1-based directory entry or text line offset to start reading from",
        )
        expect(byName.read?.properties?.limit?.description).toBe(
          "The maximum number of directory entries or text lines to read",
        )
        // Root unions keep every branch argument visible after the object projection.
        expect(Object.keys(byName.browser?.properties ?? {})).toEqual(
          expect.arrayContaining(["action", "url", "x", "y", "actions"]),
        )
        if (route.pkg === "@ai-sdk/google")
          expect(byName.todowrite?.properties?.todos?.items?.properties).toHaveProperty("content")
      }),
    )

  it.live("bedrock converse sends object input schemas for every shipped tool", () =>
    Effect.gen(function* () {
      const tools = yield* shippedTools()
      const prepared = yield* LLMClient.prepare(
        LLM.request({
          model: AmazonBedrock.configure({ baseURL: "https://bedrock-runtime.test", apiKey: "fixture" }).model(
            "anthropic.claude-haiku-5-5",
          ),
          prompt: "hello",
          tools,
        }),
      )
      const specs = (prepared.body as { toolConfig: { tools: { toolSpec?: BedrockSpec }[] } }).toolConfig.tools.flatMap(
        (tool) => (tool.toolSpec ? [tool.toolSpec] : []),
      )
      expect(specs.map((spec) => spec.name)).toEqual(tools.map((tool) => tool.name))
      for (const spec of specs) {
        const original = tools.find((definition) => definition.name === spec.name)!
        expect(spec.name).toMatch(NAME)
        expect(spec.description.length).toBeGreaterThan(0)
        expect(spec.description).toBe(original.description)
        expect(descriptions(spec.inputSchema.json)).toEqual(expect.arrayContaining(descriptions(original.inputSchema)))
        expect({ name: spec.name, type: spec.inputSchema.json.type }).toEqual({ name: spec.name, type: "object" })
      }
    }),
  )
})

type JsonNode = {
  type?: unknown
  properties?: Record<string, JsonNode>
  items?: JsonNode
  [key: string]: unknown
}
type BedrockSpec = { name: string; description: string; inputSchema: { json: JsonNode } }

const shippedTools = Effect.fn("test.shippedTools")(function* () {
  const registry = yield* ToolRegistry.Service
  const definitions = (yield* registry.materialize()).definitions
  // Browser registration is skipped under Bun on Windows; lower its real input schema anyway.
  const tools = definitions.some((tool) => tool.name === "browser")
    ? definitions
    : [
        ...definitions,
        Tool.definition(
          "browser",
          Tool.make({
            description: "Observe and interact with local web previews.",
            input: BrowserTool.Input,
            output: Schema.String,
            execute: () => Effect.succeed(""),
          }),
        ),
      ]
  expect(tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      "apply_patch",
      "bash",
      "browser",
      "task",
      "task_list",
      "tool_search",
      "webfetch",
      "websearch",
      "list_mcp_resources",
    ]),
  )
  return tools
})

const captureRequest = (pkg: string, provider: string, input: Omit<Parameters<typeof LLM.request>[0], "model">) =>
  Effect.gen(function* () {
    const bodies: Record<string, unknown>[] = []
    const raw: string[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const text = await request.text()
            raw.push(text)
            bodies.push(JSON.parse(text) as Record<string, unknown>)
            return Response.json({ error: { message: "fixture stops after capture" } }, { status: 400 })
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const model = yield* SessionRunnerModel.fromCatalogModel(
      ModelV2.Info.make({
        id: ModelV2.ID.make("fixture-model"),
        providerID: ProviderV2.ID.make(provider),
        name: "Fixture model",
        api: {
          id: ModelV2.ID.make(provider === "deepseek" ? "deepseek-chat" : "fixture-model"),
          type: "aisdk",
          package: pkg,
          url: `http://127.0.0.1:${server.port}/v1`,
        },
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        request: { headers: {}, body: {} },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 200_000, output: 8_000 },
      }),
      { type: "key", key: "fixture-only" },
    )
    yield* LLMClient.generate(LLM.request({ ...input, model })).pipe(
      Effect.provide(
        LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer)))),
      ),
      Effect.exit,
    )
    expect(bodies).toHaveLength(1)
    return { body: bodies[0]!, raw: raw[0]! }
  })

const captureBody = (pkg: string, provider: string, tools: ReadonlyArray<ToolDefinition>) =>
  captureRequest(pkg, provider, { prompt: "hello", tools }).pipe(Effect.map((captured) => captured.body))

describe("545 text-only provider wire", () => {
  it.live("Anthropic sends serialized redacted thinking and signatures unchanged over HTTP", () =>
    Effect.gen(function* () {
      const messages = [
        Message.user("Inspect the fixture."),
        Message.assistant([
          { type: "reasoning", text: "signed", providerMetadata: { anthropic: { signature: "fixture-signature" } } },
          { type: "reasoning", text: "", providerMetadata: { anthropic: { redactedThinking: "opaque+/fixture==" } } },
          { type: "reasoning", text: "", providerMetadata: { anthropic: { redactedThinking: "" } } },
          ToolCallPart.make({ id: "call-fixture", name: "bash", input: { command: "fixture" } }),
        ]),
        Message.tool({ id: "call-fixture", name: "bash", result: "fixture-output" }),
      ]
      const captured = yield* captureRequest("@ai-sdk/anthropic", "wanyin-fixture", {
        messages: JSON.parse(JSON.stringify(messages)),
        tools: [],
        toolChoice: "none",
        cache: "none",
      })
      expect(captured.body.tool_choice).toEqual({ type: "none" })
      expect((captured.body.messages as { content: unknown[] }[])[1]?.content).toEqual([
        { type: "thinking", thinking: "signed", signature: "fixture-signature" },
        { type: "redacted_thinking", data: "opaque+/fixture==" },
        { type: "redacted_thinking", data: "" },
        { type: "tool_use", id: "call-fixture", name: "bash", input: { command: "fixture" } },
      ])
    }),
  )

  for (const mode of ["last-step", "text-recovery", "delivery-report"]) {
    for (const route of [
      { pkg: "@ai-sdk/anthropic", provider: "wanyin-fixture" },
      { pkg: "@ai-sdk/openai", provider: "openai" },
      { pkg: "@ai-sdk/openai-compatible", provider: "compatible" },
    ]) {
      it.live(`${mode} keeps ${route.pkg} history valid without permitting another tool call`, () =>
        Effect.gen(function* () {
          const messages = [
            Message.user("Inspect the fixture."),
            Message.assistant([ToolCallPart.make({ id: "call-fixture", name: "bash", input: { command: "fixture" } })]),
            Message.tool({ id: "call-fixture", name: "bash", result: "fixture-output" }),
            Message.user(`Finish in text only: ${mode}.`),
          ]
          const captured = yield* captureRequest(route.pkg, route.provider, {
            messages,
            tools: [],
            toolChoice: "none",
            cache: "none",
          })
          if (route.pkg === "@ai-sdk/anthropic") {
            expect(captured.body.tool_choice).toEqual({ type: "none" })
            expect((captured.body.tools as { name: string }[]).map((tool) => tool.name)).toEqual(["bash"])
            expect(JSON.stringify(captured.body.messages)).toContain('"type":"tool_use"')
            expect(JSON.stringify(captured.body.messages)).toContain('"type":"tool_result"')
          }
          if (route.pkg !== "@ai-sdk/anthropic") {
            expect(captured.body.tools).toBeUndefined()
            const baseline = openAIWire545.find((entry) => entry.name === `${route.provider}-${mode}`)
            expect(baseline).toBeDefined()
            expect(captured.raw).toBe(baseline!.body)
            expect(new Bun.CryptoHasher("sha256").update(captured.raw).digest("hex")).toBe(baseline!.sha256)
            const directory = process.env.ZAOVRA_PROVIDER_WIRE_REPORT
            if (directory) {
              yield* Effect.promise(() => Bun.write(`${directory}/${route.provider}-${mode}.txt`, captured.raw))
            }
          }
          expect(messages[1]?.content[0]?.type).toBe("tool-call")
        }),
      )
    }
  }
})

function loweredTools(pkg: string, body: Record<string, unknown>) {
  if (pkg === "@ai-sdk/anthropic")
    return (body.tools as { name: string; description: string; input_schema: JsonNode }[]).map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.input_schema,
    }))
  if (pkg === "@ai-sdk/google")
    return (
      body.tools as { functionDeclarations: { name: string; description: string; parameters?: JsonNode }[] }[]
    ).flatMap((group) =>
      group.functionDeclarations.map((tool) => ({
        name: tool.name,
        description: tool.description,
        schema: tool.parameters,
      })),
    )
  if (pkg === "@ai-sdk/openai")
    return (body.tools as { name: string; description: string; parameters: JsonNode }[]).map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.parameters,
    }))
  return (body.tools as { function: { name: string; description: string; parameters: JsonNode } }[]).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    schema: tool.function.parameters,
  }))
}

// Object-root and Gemini projections reshape unions and inline definitions.
// Compare annotation text independently of that shape, then assert critical
// parameter placement above so equal prose on the wrong field cannot satisfy it.
function descriptions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(descriptions)
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, child]) =>
    key === "description" && typeof child === "string" ? [child] : descriptions(child),
  )
}

function geminiViolations(schema: JsonNode, path: string): string[] {
  return [
    ...Object.keys(schema)
      .filter((key) => !GEMINI_FIELDS.has(key))
      .map((key) => `${path}: unsupported field ${key}`),
    ...(/[.|[]/.test(path) || schema.type === "object" ? [] : [`${path}: root type ${String(schema.type)}`]),
    ...(schema.type === undefined || GEMINI_TYPES.has(String(schema.type))
      ? []
      : [`${path}: unsupported type ${JSON.stringify(schema.type)}`]),
    ...(schema.type === "array" && schema.items === undefined ? [`${path}: array without items`] : []),
    ...Object.entries(schema.properties ?? {}).flatMap(([key, value]) => geminiViolations(value, `${path}.${key}`)),
    ...(schema.items ? geminiViolations(schema.items, `${path}[]`) : []),
    ...(Array.isArray(schema.anyOf)
      ? schema.anyOf.flatMap((value: JsonNode, index: number) => geminiViolations(value, `${path}|${index}`))
      : []),
  ]
}
