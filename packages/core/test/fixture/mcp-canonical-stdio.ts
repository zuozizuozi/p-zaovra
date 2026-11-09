import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { once } from "node:events"
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js"
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

// Exceed pipe capacity before initialization; the host must continuously drain stderr.
if (process.env.MCP_TEST_STDERR === "1") {
  for (let index = 0; index < 128; index++)
    if (!process.stderr.write("x".repeat(65_536))) await once(process.stderr, "drain")
}

const server = new Server(
  { name: "mcp-canonical-fixture", version: "1.0.0" },
  {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: "Use project facts as the durable source of truth.",
  },
)
let revision = 0
let approvalCalls = 0
let outputCalls = 0
let toolName = process.env.MCP_TEST_TOOL ?? "echo"

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      {
        name: toolName,
        description: `Echo one string ${revision}`,
        inputSchema: process.env.MCP_TEST_SCHEMA
          ? JSON.parse(process.env.MCP_TEST_SCHEMA)
          : {
              type: "object",
              properties: {
                text: { type: "string", minLength: revision + 1 },
                ...(process.env.MCP_TEST_APPROVAL === "1"
                  ? { nested: { type: "object" }, apiKey: { type: "string" } }
                  : {}),
              },
              required: ["text"],
              additionalProperties: false,
            },
        ...(process.env.MCP_TEST_OUTPUT_MODE === "required" ? { execution: { taskSupport: "required" as const } } : {}),
        outputSchema:
          process.env.MCP_TEST_OUTPUT_MODE === "no-schema"
            ? undefined
            : {
                ...(process.env.MCP_TEST_OUTPUT_MODE === "unsupported"
                  ? { $schema: "https://invalid.test/output-schema" }
                  : {}),
                type: "object",
                properties: {
                  echo: { type: "string", ...(process.env.MCP_TEST_OUTPUT_MODE === "enum" ? { enum: ["ok"] } : {}) },
                },
                required: ["echo"],
                additionalProperties: false,
              },
      },
    ],
  }),
)

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (process.env.MCP_TEST_OUTPUT_MODE) {
    if (process.env.MCP_TEST_CALL_FILE) await Bun.write(process.env.MCP_TEST_CALL_FILE, String(++outputCalls))
    const mode = process.env.MCP_TEST_OUTPUT_MODE
    if (mode === "rpc-error") throw new McpError(ErrorCode.InternalError, "fixture result unavailable")
    if (mode === "timeout" || mode === "cancel") await new Promise(() => {})
    return {
      content:
        mode === "structured" || mode === "missing-text"
          ? []
          : [{ type: "text" as const, text: "fixture side effect receipt" }],
      ...(mode === "missing" || mode === "missing-text"
        ? {}
        : { structuredContent: { echo: mode === "valid" ? "ok" : mode === "enum" ? "other" : 123 } }),
      ...(mode === "error" ? { isError: true } : {}),
    }
  }
  const text = typeof request.params.arguments?.text === "string" ? request.params.arguments.text : ""
  if (text === "notify" || text === "change-schema" || text === "change-name") {
    if (text === "change-schema") revision++
    if (text === "change-name") toolName += "_renamed"
    await server.sendToolListChanged()
  }
  if (text.startsWith("error:"))
    return Promise.resolve({ isError: true, content: [{ type: "text", text: text.slice(6) }] })
  return Promise.resolve({
    content: [
      {
        type: "text",
        text:
          process.env.MCP_TEST_APPROVAL === "1"
            ? JSON.stringify({ arguments: request.params.arguments, calls: ++approvalCalls })
            : process.env.MCP_TEST_SERVER
              ? `${process.env.MCP_TEST_SERVER}:${request.params.name}:${text}`
              : `echo:${text}`,
      },
    ],
    structuredContent: { echo: text },
  })
})

server.setRequestHandler(ListResourcesRequestSchema, () =>
  Promise.resolve({ resources: [{ name: "project facts", uri: "memory://project/facts", mimeType: "text/plain" }] }),
)
server.setRequestHandler(ListResourceTemplatesRequestSchema, () =>
  Promise.resolve({ resourceTemplates: [{ name: "decision", uriTemplate: "memory://decision/{id}" }] }),
)
server.setRequestHandler(ReadResourceRequestSchema, (request) =>
  Promise.resolve({ contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "ZAOVRA uses WorkGraph." }] }),
)
server.setRequestHandler(ListPromptsRequestSchema, () =>
  Promise.resolve({ prompts: [{ name: "review", description: "Review one change" }] }),
)
server.setRequestHandler(GetPromptRequestSchema, (request) =>
  Promise.resolve({
    description: "Review one change",
    messages: [
      { role: "user", content: { type: "text", text: `Review ${request.params.arguments?.target ?? "change"}` } },
    ],
  }),
)

await server.connect(new StdioServerTransport())
