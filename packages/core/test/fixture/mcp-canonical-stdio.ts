import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

const server = new Server(
  { name: "mcp-canonical-fixture", version: "1.0.0" },
  {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: "Use project facts as the durable source of truth.",
  },
)

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      {
        name: "echo",
        description: "Echo one string",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", minLength: 1 } },
          required: ["text"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { echo: { type: "string" } },
          required: ["echo"],
          additionalProperties: false,
        },
      },
    ],
  }),
)

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const text = typeof request.params.arguments?.text === "string" ? request.params.arguments.text : ""
  return Promise.resolve({
    content: [{ type: "text", text: `echo:${text}` }],
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
