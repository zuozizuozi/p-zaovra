import { visibleProgress } from "../../src/pages/session/composer/visible-progress"
import { createServerSession } from "../../src/context/server-session"
import type { Message, Part, Todo, ZaovraClient } from "@zaovra-ai/sdk/v2/client"

const messages: Message[] = Array.from({ length: 40 }, (_, index) => [
  {
    id: `user-${index}`,
    sessionID: "bench732",
    role: "user",
    time: { created: index * 2 },
    agent: "build",
    model: { providerID: "fixed", modelID: "offline" },
  },
  {
    id: `assistant-${index}`,
    parentID: `user-${index}`,
    sessionID: "bench732",
    role: "assistant",
    time: { created: index * 2 + 1, completed: index * 2 + 2 },
    agent: "build",
    mode: "build",
    providerID: "fixed",
    modelID: "offline",
    path: { cwd: "/fixture", root: "/fixture" },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: index === 39 ? "interrupted" : "stop",
  },
]).flat() as Message[]
const parts = Object.fromEntries(
  messages.map((message) => [
    message.id,
    [
      {
        id: `text-${message.id}`,
        sessionID: "bench732",
        messageID: message.id,
        type: "text",
        text: "Retained production context",
      },
      ...(message.role === "assistant"
        ? [
            {
              id: `tool-${message.id}`,
              sessionID: "bench732",
              messageID: message.id,
              type: "tool",
              tool: "bash",
              callID: `call-${message.id}`,
              state: {
                status: "error",
                input: { command: "offline" },
                error: "Tool execution interrupted",
                time: { start: 1, end: 2 },
              },
            },
          ]
        : []),
    ] as Part[],
  ]),
)
const todos: Todo[] = Array.from({ length: 100 }, (_, index) => ({
  content: `Retained item ${index}`,
  status: "completed",
  priority: "medium",
}))
const client = { v2: { session: { todos: async () => ({ data: { data: todos } }) } } } as unknown as ZaovraClient
const samples = []
for (let sample = 0; sample < 13; sample++) {
  const store = createServerSession(client)
  const start = performance.now()
  for (let repeat = 0; repeat < 32; repeat++) {
    visibleProgress({ sessionID: "bench732", messages, parts, busy: false, waiting: false, historyComplete: true })
    await store.todo("bench732", { force: true })
  }
  const elapsed = performance.now() - start
  if (sample > 1) samples.push(elapsed)
}
console.log(
  JSON.stringify({
    workload: "80 messages/120 parts; 32 progress projections and 100-todo hydrations per sample",
    samples,
    medianMs: samples.toSorted((a, b) => a - b)[5],
    boundary: "Narrow CPU only; no native UI latency claim, no model or HTTP calls",
  }),
)
