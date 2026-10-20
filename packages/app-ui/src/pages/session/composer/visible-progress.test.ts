import { expect, test } from "bun:test"
import { adaptSessionMessages } from "@/context/v2-session-adapter"
import type { SessionMessage, SessionV2Info } from "@zaovra-ai/sdk/v2/client"
import { visibleProgress } from "./visible-progress"

test("out-of-order history replay preserves a finished background job and its goal", () => {
  const history: SessionMessage[] = [
    { id: "u1", type: "user", text: "Inspect the result", time: { created: 1 } },
    {
      id: "a1", type: "assistant", agent: "build", model: { id: "m", providerID: "p" },
      time: { created: 2 },
      content: [{
        id: "launch", type: "tool", name: "bash", time: { created: 2, completed: 3 },
        state: { status: "completed", input: {}, content: [], structured: { job_id: "job_replay" } },
      }],
    },
    {
      id: "a2", type: "assistant", agent: "build", model: { id: "m", providerID: "p" },
      time: { created: 4, completed: 5 },
      content: [{
        id: "poll", type: "tool", name: "bash_job", time: { created: 4, completed: 5 },
        state: { status: "completed", input: { job_id: "job_replay" }, content: [], structured: { status: "finished" } },
      }, { id: "claim", type: "text", text: "Everything passed!" }],
    },
  ]
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const rows = adaptSessionMessages(session, order.map((index) => history[index]))
    const input = {
      sessionID: session.id,
      messages: rows.map((row) => row.message),
      parts: Object.fromEntries(rows.map((row) => [row.message.id, row.parts])),
      busy: false,
      waiting: false,
    }
    const result = visibleProgress(input)
    expect(result.target).toBe("Inspect the result")
    expect(result.state).toBe("idle")
    expect(result.visible).toBe(false)
    expect(result.facts.map((fact) => fact.tool)).toEqual(["bash", "bash_job"])
    expect(result.failures).toEqual([])
    expect(visibleProgress(input)).toEqual(result)
    expect(visibleProgress({ ...input, busy: true }).state).toBe("running")
  }
})

const session = {
  id: "ses_m",
  projectID: "p",
  title: "m",
  location: { directory: "/repo" },
  time: { created: 0, updated: 0 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
} satisfies SessionV2Info
function run(content: Extract<SessionMessage, { type: "assistant" }>["content"], waiting = false) {
  const rows = adaptSessionMessages(session, [
    { id: "u", type: "user", text: "Check the CLI", time: { created: 1 } },
    { id: "a", type: "assistant", agent: "build", model: { id: "m", providerID: "p" }, time: { created: 2 }, content },
  ])
  return visibleProgress({
    sessionID: session.id,
    messages: rows.map((row) => row.message),
    parts: Object.fromEntries(rows.map((row) => [row.message.id, row.parts])),
    busy: true,
    waiting,
  })
}
test("assistant claims are never completion evidence", () => {
  const result = run([{ id: "t", type: "text", text: "All tests passed. Done!" }])
  expect(result.state).toBe("running")
  expect(result.fact).toBeUndefined()
  expect(result.target).toBe("Check the CLI")
})
test("running validation and pending user input stay explicit", () => {
  const content = [
    {
      id: "call",
      type: "tool",
      name: "bash",
      time: { created: 2 },
      state: { status: "running", input: {}, content: [], structured: {} },
    },
  ] satisfies Extract<SessionMessage, { type: "assistant" }>["content"]
  expect(run(content).state).toBe("tool")
  expect(run(content, true).state).toBe("waiting")
})
test("a tool error is retained rather than reported as no result", () => {
  const result = run([
    {
      id: "call",
      type: "tool",
      name: "bash",
      time: { created: 2, completed: 3 },
      state: { status: "error", input: {}, content: [], structured: {}, error: { type: "unknown", message: "exit 1" } },
    },
  ])
  expect(result.failures).toHaveLength(1)
  expect(result.failures[0].error).toBe("exit 1")
  expect(result.fact).toBeUndefined()
})
test("another session cannot supply the target or facts", () => {
  const rows = adaptSessionMessages(session, [{ id: "u", type: "user", text: "private target", time: { created: 1 } }])
  expect(
    visibleProgress({
      sessionID: "another",
      messages: rows.map((row) => row.message),
      parts: Object.fromEntries(rows.map((row) => [row.message.id, row.parts])),
      busy: true,
      waiting: false,
    }).target,
  ).toBe("")
})

test("a returned background command is not a finished job", () => {
  const result = run([
    {
      id: "call",
      type: "tool",
      name: "bash",
      time: { created: 2, completed: 3 },
      state: { status: "completed", input: {}, content: [], structured: { job_id: "job_1" } },
    },
  ])
  expect(result.state).toBe("tool")
})

test("a later queued prompt does not replace the active assistant's goal", () => {
  const rows = adaptSessionMessages(session, [
    { id: "u", type: "user", text: "active", time: { created: 1 } },
    {
      id: "a",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 2 },
      content: [],
    },
    { id: "queued", type: "user", text: "next", time: { created: 3 } },
  ])
  const input = {
    sessionID: session.id,
    messages: rows.map((row) => row.message),
    parts: Object.fromEntries(rows.map((row) => [row.message.id, row.parts])),
    busy: true,
    waiting: false,
  }
  expect(visibleProgress(input).target).toBe("active")
})

test("background job completion clears activity without declaring task success", () => {
  const launch = {
    id: "launch",
    type: "tool",
    name: "bash",
    time: { created: 2, completed: 3 },
    state: { status: "completed", input: {}, content: [], structured: { job_id: "job_1" } },
  } satisfies Extract<SessionMessage, { type: "assistant" }>["content"][number]
  const status = (value: string) =>
    ({
      id: "poll",
      type: "tool",
      name: "bash_job",
      time: { created: 4, completed: 5 },
      state: { status: "completed", input: { job_id: "job_1" }, content: [], structured: { status: value } },
    }) satisfies Extract<SessionMessage, { type: "assistant" }>["content"][number]
  expect(run([launch, status("unavailable")]).state).toBe("tool")
  const finished = run([launch, status("finished")])
  expect(finished.state).toBe("running")
  expect(finished.fact).toBe("bash_job")
  expect(finished.facts.map((fact) => fact.tool)).toEqual(["bash", "bash_job"])
  expect(run([launch, status("finished")])).toEqual(finished)
})

test("another session's background job cannot keep this session active", () => {
  const rows = adaptSessionMessages(session, [{ id: "u", type: "user", text: "current", time: { created: 1 } }])
  const other = adaptSessionMessages({ ...session, id: "ses_other" }, [
    { id: "other-u", type: "user", text: "other", time: { created: 1 } },
    {
      id: "other-a",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 2 },
      content: [
        {
          id: "other-job",
          type: "tool",
          name: "bash",
          time: { created: 2, completed: 3 },
          state: { status: "completed", input: {}, content: [], structured: { job_id: "job_1" } },
        },
      ],
    },
  ])
  const all = [...rows, ...other]
  const result = visibleProgress({
    sessionID: session.id,
    messages: all.map((row) => row.message),
    parts: Object.fromEntries(all.map((row) => [row.message.id, row.parts])),
    busy: false,
    waiting: false,
  })
  expect(result.target).toBe("current")
  expect(result.state).toBe("idle")
  expect(result.visible).toBe(false)
  expect(result.facts).toEqual([])
  expect(result.failures).toEqual([])
})
