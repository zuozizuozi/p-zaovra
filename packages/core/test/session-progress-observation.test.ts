import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionMessage } from "../src/session/message"
import { SessionProgress } from "../src/session/progress"

function tool(state: SessionMessage.ToolState, name = "bash"): SessionMessage.AssistantTool {
  return { type: "tool", id: "call", name, state, time: { created: DateTime.makeUnsafe(1) } }
}

function completed(input: Record<string, unknown> = {}, structured: Record<string, unknown> = {}, text = "failure") {
  return tool({ status: "completed", input, structured, content: [{ type: "text", text }] })
}

test("observation skips nonterminal tools and unknown successful work", () => {
  expect(SessionProgress.prepareObservation(tool({ status: "pending", input: "{}" }), "/project")).toBeUndefined()
  expect(
    SessionProgress.prepareObservation(tool({ status: "running", input: {}, structured: {}, content: [] }), "/project"),
  ).toBeUndefined()
  expect(
    SessionProgress.prepareObservation(completed({ command: "npm test" }, { exit: 0 }), "/project"),
  ).toBeUndefined()
  expect(
    SessionProgress.prepareObservation(completed({ command: "cat file" }, { exit: 0 }, ""), "/project"),
  ).toBeUndefined()
  expect(SessionProgress.prepareObservation({ type: "text", id: "text", text: "done" }, "/project")).toBeUndefined()
})

test("observation preserves error over timeout over exit and cwd precedence", () => {
  const error = tool({
    status: "error",
    input: { workdir: "/input" },
    structured: { timeout: true, exit: 2, workdir: "/structured" },
    content: [],
    error: { type: "unknown", message: " host failure " },
  })
  expect(SessionProgress.prepareObservation(error, "/project")).toMatchObject({
    category: "tool-error",
    cwd: "/input",
    error: "host failure",
  })
  expect(
    SessionProgress.prepareObservation(
      completed({ workdir: "/input" }, { timeout: true, exit: 2, workdir: "/structured" }),
      "/project",
    ),
  ).toMatchObject({ category: "timeout", cwd: "/structured" })
  expect(SessionProgress.prepareObservation(completed({ workdir: "/input" }, { exit: -1 }), "/project")).toMatchObject({
    category: "exit--1",
    cwd: "/input",
  })
  expect(SessionProgress.prepareObservation(completed({ workdir: 1 }, { exit: 1 }), "/project")).toMatchObject({
    category: "exit-1",
    cwd: "/project",
  })
})

test("display is limited to 512 while evidence retains the full untrimmed error", () => {
  const first = SessionProgress.prepareObservation(completed({}, { exit: 1 }, " " + "x".repeat(512) + "A"), "/project")!
  const second = SessionProgress.prepareObservation(
    completed({}, { exit: 1 }, " " + "x".repeat(512) + "B"),
    "/project",
  )!
  const a = SessionProgress.completeObservation(first, "shell", "snapshot")
  const b = SessionProgress.completeObservation(second, "shell", "snapshot")
  expect(a.error).toHaveLength(512)
  expect(a.error).toBe(b.error)
  expect(a.evidence).not.toBe(b.evidence)
  expect(a.evidence).toHaveLength(64)
  expect(Object.keys(a)).toEqual([
    "category",
    "error",
    "cwd",
    "environment",
    "artifact",
    "hypothesis",
    "expectedEvidence",
    "evidence",
  ])
})

test("observation completes optional fields only after the supplied snapshot boundary", () => {
  const input: Record<string, unknown> = { progress_hypothesis: 1, progress_expected_evidence: null }
  const prepared = SessionProgress.prepareObservation(completed(input, { exit: 1 }), "/project")!
  expect(SessionProgress.completeObservation(prepared, undefined, undefined)).toMatchObject({
    environment: undefined,
    artifact: undefined,
    hypothesis: undefined,
    expectedEvidence: undefined,
  })
  input.progress_hypothesis = "after capture"
  input.progress_expected_evidence = "assertion"
  expect(SessionProgress.completeObservation(prepared, "shell", "snapshot")).toMatchObject({
    environment: "shell",
    artifact: "snapshot",
    hypothesis: "after capture",
    expectedEvidence: "assertion",
  })
})

test("successful recognized reads preserve evidence while successful polling is excluded", () => {
  const read = completed({ path: "source.ts" }, { content: "same source", exit: 0 }, "formatted read")
  const prepared = SessionProgress.prepareObservation({ ...read, name: "read" }, "/project")!
  const observed = SessionProgress.completeObservation(prepared, "shell", "snapshot")
  expect(observed.category).toBe("read-only")
  expect(observed.error).toBe("")
  expect(prepared.read).toBeDefined()
  expect(observed.evidence).toBe(prepared.read!)
  expect(SessionProgress.prepareObservation({ ...read, name: "bash_job" }, "/project")).toBeUndefined()
})

const current = {
  category: "read-only",
  error: "",
  cwd: "/project",
  environment: "shell",
  artifact: "snapshot",
  evidence: "same",
  hypothesis: "entry",
}
for (const enabled of [false, true])
  for (const continuing of [false, true])
    for (const last of [false, true])
      test(`diagnostic message gate enabled=${enabled} continuing=${continuing} last=${last}`, () => {
        const result = SessionProgress.diagnosticMessage([current, current], current, {
          enabled,
          continuing,
          last,
          userID: "request",
        })
        expect(result.key !== undefined).toBe(enabled && continuing && !last)
        expect(result.prefix).toBe(`Stagnation diagnostic request:${result.key}:`)
        expect(result.text).toBe(`${result.prefix} ${SessionProgress.diagnosticReminder}`)
      })

test("diagnostic consecutive history is not observe's same-family filter", () => {
  const previous = [{ ...current, category: "exit-1" }, current, current]
  expect(SessionProgress.observe(previous, current).candidate).toBe(true)
  expect(
    SessionProgress.diagnosticMessage(previous, current, { enabled: true, continuing: true, last: false }).key,
  ).toBeUndefined()
  expect(
    SessionProgress.diagnosticMessage([current, current], current, { enabled: true, continuing: true, last: false })
      .prefix,
  ).toStartWith("Stagnation diagnostic undefined:")
})
