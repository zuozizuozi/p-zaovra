import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { AssistantMessage, Message, Part, UserMessage } from "@zaovra-ai/sdk/v2"
import { createTimelineProjection } from "../../src/pages/session/timeline/projection"

const users = Array.from(
  { length: 100 },
  (_, index) =>
    ({
      id: `user-${String(index).padStart(4, "0")}`,
      sessionID: "parity724",
      role: "user",
      time: { created: index * 2 },
      agent: "build",
      model: { providerID: "fixed", modelID: "fixture" },
    }) as UserMessage,
)
const assistants = users.map(
  (user, index) =>
    ({
      id: `assistant-${String(index).padStart(4, "0")}`,
      parentID: user.id,
      sessionID: "parity724",
      role: "assistant",
      time: { created: index * 2 + 1, completed: index * 2 + 2 },
      agent: "build",
      mode: "build",
      providerID: "fixed",
      modelID: "fixture",
      path: { cwd: "/fixture", root: "/fixture" },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
      finish: "stop",
    }) as AssistantMessage,
)
const messages: Message[] = [...users, ...assistants].toSorted((a, b) => a.id.localeCompare(b.id))
const parts = Object.fromEntries(
  messages.map((message) => [
    message.id,
    (message.role === "user"
      ? [
          {
            id: `part-${message.id}`,
            messageID: message.id,
            sessionID: "parity724",
            type: "text",
            text: "Explain the project",
          },
        ]
      : [
          {
            id: `reason-${message.id}`,
            messageID: message.id,
            sessionID: "parity724",
            type: "reasoning",
            text: "Inspecting the production tree",
            time: { start: 1, end: 2 },
          },
          {
            id: `text-${message.id}`,
            messageID: message.id,
            sessionID: "parity724",
            type: "text",
            text: "A concrete answer with retained context.",
          },
        ]) as Part[],
  ]),
)

const sample = () =>
  createRoot((dispose) => {
    const [state, setState] = createStore({ reasoning: false, working: false })
    const start = performance.now()
    const projection = createTimelineProjection({
      messages: () => messages,
      userMessages: () => users,
      parts: (id) => parts[id] ?? [],
      status: () => (state.working ? { type: "busy" } : { type: "idle" }),
      showReasoningSummaries: () => state.reasoning,
      inlineComments: () => true,
      historyComplete: () => true,
    })
    let rows = 0
    for (let index = 0; index < 40; index++) {
      setState({ reasoning: index % 2 === 0, working: index % 3 === 0 })
      rows += projection.rows().length
      projection.rowByKey()
      projection.messageLastRowIndex()
    }
    const duration = performance.now() - start
    dispose()
    if (!rows) throw new Error("Production projection produced no rows")
    return { duration, rows }
  })
Array.from({ length: 3 }, sample)
const samples = Array.from({ length: 21 }, sample)
const sorted = samples.map((sample) => sample.duration).toSorted((a, b) => a - b)
console.log(
  JSON.stringify({
    benchmark: "724 production createTimelineProjection",
    messages: messages.length,
    parts: Object.values(parts).flat().length,
    transitions: 40,
    samples,
    medianMs: sorted[10],
    p95Ms: sorted[19],
    modelCalls: 0,
  }),
)
// This standalone benchmark owns its DOM runtime; do not leave its timers alive.
process.exit(0)
