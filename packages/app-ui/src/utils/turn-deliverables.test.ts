import { expect, test } from "bun:test"
import type { SessionMessage, SessionV2Info } from "@zaovra-ai/sdk/v2/client"
import { adaptSessionMessages } from "../context/v2-session-adapter"
import { turnDeliverables } from "./turn-deliverables"

const session: SessionV2Info = {
  id: "ses_delivery",
  projectID: "project",
  agent: "build",
  model: { id: "local", providerID: "fixture" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  title: "delivery",
  location: { directory: "/project" },
}
function derive(content: Extract<SessionMessage, { type: "assistant" }>["content"], completed = true) {
  const rows = adaptSessionMessages(session, [
    { id: "user", type: "user", text: "make report", time: { created: 1 } },
    {
      id: "answer",
      type: "assistant",
      agent: "build",
      model: session.model!,
      time: { created: 2, ...(completed ? { completed: 3 } : {}) },
      content,
    },
  ])
  return turnDeliverables({
    messages: rows.map((row) => row.message),
    parts: Object.fromEntries(rows.map((row) => [row.message.id, row.parts])),
    messageID: "user",
    directory: "/project",
  })
}
function tool(
  name: string,
  target: string,
  outputPaths?: string[],
): Extract<Extract<SessionMessage, { type: "assistant" }>["content"][number], { type: "tool" }> {
  return {
    id: name + target,
    type: "tool",
    name,
    time: { created: 2, ran: 2, completed: 3 },
    state: { status: "completed", input: { path: target }, content: [], structured: {}, outputPaths },
  }
}

test("actual output carriers produce cards; source edits and implicit retained logs do not", () => {
  expect(
    derive([tool("write", "report.html"), tool("edit", "src/app.ts"), tool("bash", "ignored", ["/project/log.txt"])]),
  ).toEqual([{ target: "report.html", kind: "file", source: "tool" }])
  expect(derive([tool("write", "report.pdf")], false)).toEqual([])
  expect(derive([tool("read", "old.pdf")])).toEqual([])
})

test("final file declarations without a trusted carrier require this turn's file metadata", () => {
  expect(
    derive([
      tool("write", "report.csv"),
      {
        id: "final",
        type: "text",
        text: "[Report](report.csv), [old](existing.pdf), `src/app.ts`, [Site](https://example.com/demo).",
      },
    ]),
  ).toEqual([
    { target: "https://example.com/demo", kind: "link", source: "reply" },
    { target: "report.csv", kind: "file", source: "reply" },
    { target: "existing.pdf", kind: "file", source: "reply", after: 1, before: 3 },
    { target: "src/app.ts", kind: "file", source: "reply", after: 1, before: 3 },
  ])
})

test("publish and output attachments deduplicate; project escapes and credential URLs are excluded", () => {
  const published = tool("publish_artifact", "report.pdf")
  if (published.state.status === "completed")
    published.state.attachments = [{ uri: "file:///project/report.pdf", mime: "application/pdf", name: "report.pdf" }]
  expect(
    derive([
      published,
      tool("write", "report.pdf"),
      tool("write", "../outside.pdf"),
      { id: "final", type: "text", text: "[secret](https://user:pass@example.com/a) [malformed](https://[broken)" },
    ]),
  ).toEqual([{ target: "report.pdf", kind: "file", source: "tool" }])
})

test("only the requested admitted turn is collected on reload or session change", () => {
  expect(turnDeliverables({ messages: [], parts: {}, messageID: "missing", directory: "/project" })).toEqual([])
  const rows = adaptSessionMessages(session, [
    { id: "old", type: "user", text: "old", time: { created: 1 } },
    {
      id: "old-answer",
      type: "assistant",
      agent: "build",
      model: session.model!,
      time: { created: 2, completed: 3 },
      content: [tool("write", "old.pdf")],
    },
    { id: "new", type: "user", text: "new", time: { created: 4 } },
  ])
  expect(
    turnDeliverables({
      messages: rows.map((row) => row.message),
      parts: Object.fromEntries(rows.map((row) => [row.message.id, row.parts])),
      messageID: "new",
      directory: "/project",
    }),
  ).toEqual([])
})

test("plain final file names are candidates but retained command logs are never promoted", () => {
  expect(
    derive([
      tool("bash", "ignored", ["/project/command.txt"]),
      { id: "final", type: "text", text: "Created report.pdf and images/chart.png; log: `command.txt`." },
    ]),
  ).toEqual([
    { target: "report.pdf", kind: "file", source: "reply", after: 1, before: 3 },
    { target: "images/chart.png", kind: "file", source: "reply", after: 1, before: 3 },
  ])
})
