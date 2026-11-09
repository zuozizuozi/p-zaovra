import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import fs from "node:fs/promises"
const record = async (event: string, data?: unknown) => {
  if (process.env.ZAOVRA_766_MCP_LOG)
    await fs.appendFile(process.env.ZAOVRA_766_MCP_LOG, JSON.stringify({ event, data, pid: process.pid }) + "\n")
}
const server = new Server(
  { name: "customization766", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } } },
)
let revision = 0
let promptLists = 0
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Synthetic local echo",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ],
}))
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  await record("listPrompts")
  if (process.env.ZAOVRA_766_PROMPT_FAIL_ONCE === "1" && promptLists++ === 0)
    throw new Error("Synthetic prompt list failure")
  return {
    prompts: [
      { name: "review", description: "Review a supplied target", arguments: [{ name: "target", required: true }] },
      {
        name: "pair",
        description: "Two arguments",
        arguments: [
          { name: "first", required: true },
          { name: "second", required: true },
        ],
      },
      ...(revision ? [{ name: "added", description: "Announced later" }] : []),
    ],
  }
})
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  await record("getPrompt", request.params)
  if (request.params.name === "image")
    return {
      messages: [{ role: "user" as const, content: { type: "image" as const, data: "AA==", mimeType: "image/png" } }],
    }
  if (request.params.name === "review" && !request.params.arguments?.target) throw new Error("Missing target")
  if (request.params.arguments?.target === "notify") {
    revision++
    await server.sendPromptListChanged()
  }
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: "MCP " + JSON.stringify(request.params.arguments ?? {}) + " literal $1 $ARGUMENTS",
        },
      },
    ],
  }
})
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await record("callTool", request.params)
  return { content: [{ type: "text" as const, text: "echo:" + request.params.arguments?.text }] }
})
const transport = new StdioServerTransport()
transport.onclose = () => {
  void record("closed")
}
await record("started")
await server.connect(transport)
