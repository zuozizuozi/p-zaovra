import { expect, test } from "bun:test"
import { adaptSessionMessages } from "@/context/v2-session-adapter"
import type { SessionMessage, SessionV2Info } from "@zaovra-ai/sdk/v2/client"
import { visibleProgress } from "./visible-progress"

test("resolved process errors leave the dock while unresolved and verification failures stay", () => {
  const history: SessionMessage[] = [
    { id: "recovery-user", type: "user", text: "Fix app.ts", time: { created: 1 } },
    {
      id: "recovery-first",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 2, completed: 3 },
      finish: "tool-calls",
      content: [
        {
          id: "failed-edit",
          type: "tool",
          name: "edit",
          time: { created: 2, completed: 3 },
          state: {
            status: "error",
            input: { path: "app.ts", oldString: "old", newString: "fixed" },
            error: {
              type: "unknown",
              message: "Could not find oldString",
              metadata: { phase: "mutation", reason: "match-failed" },
            },
            content: [],
            structured: {},
          },
        },
      ],
    },
    {
      id: "recovery-last",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 4, completed: 5 },
      finish: "stop",
      content: [
        {
          id: "fixed-edit",
          type: "tool",
          name: "edit",
          time: { created: 4, completed: 5 },
          state: {
            status: "completed",
            input: { path: "app.ts", oldString: " old ", newString: "fixed" },
            content: [],
            structured: {},
          },
        },
      ],
    },
  ]
  const rows = adaptSessionMessages(session, history)
  const input = {
    sessionID: session.id,
    messages: rows.map((row) => row.message),
    parts: Object.fromEntries(rows.map((row) => [row.message.id, row.parts])),
    busy: false,
    waiting: false,
  }
  expect(visibleProgress(input).failures).toEqual([])
  expect(visibleProgress({ ...input, busy: true }).failures).toHaveLength(1)
  const failed = rows[1].parts[0]
  if (failed.type !== "tool" || failed.state.status !== "error") throw new Error("Expected error")
  expect(failed.state.metadata?.phase).toBe("mutation")
  expect(visibleProgress({ ...input, parts: { ...input.parts, [rows[2].message.id]: [] } }).failures).toHaveLength(1)
  failed.state.error = "Verification failed: test"
  expect(visibleProgress(input).failures).toHaveLength(1)
})

test("out-of-order history replay preserves a finished background job and its goal", () => {
  const history: SessionMessage[] = [
    { id: "u1", type: "user", text: "Inspect the result", time: { created: 1 } },
    {
      id: "a1",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 2 },
      content: [
        {
          id: "launch",
          type: "tool",
          name: "bash",
          time: { created: 2, completed: 3 },
          state: { status: "completed", input: {}, content: [], structured: { job_id: "job_replay" } },
        },
      ],
    },
    {
      id: "a2",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 4, completed: 5 },
      content: [
        {
          id: "poll",
          type: "tool",
          name: "bash_job",
          time: { created: 4, completed: 5 },
          state: {
            status: "completed",
            input: { job_id: "job_replay" },
            content: [],
            structured: { status: "finished" },
          },
        },
        { id: "claim", type: "text", text: "Everything passed!" },
      ],
    },
  ]
  for (const order of [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ]) {
    const rows = adaptSessionMessages(
      session,
      order.map((index) => history[index]),
    )
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

test("ordinary nonzero commands remain actionable without claiming they were verification", () => {
  const result = run([
    {
      id: "command",
      type: "tool",
      name: "bash",
      time: { created: 2, completed: 3 },
      state: { status: "completed", input: { command: "node missing.cjs" }, content: [], structured: { exit: 1 } },
    },
  ])
  expect(result.failures).toEqual([{ id: "a:command", tool: "bash", error: "exit 1" }])
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
  expect(result.state).toBe("unverified")
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
  expect(run([launch, status("unavailable")]).state).toBe("unverified")
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

test("synthetic continuation retains the real goal and earlier failures", () => {
  const rows = adaptSessionMessages(session, [
    { id: "goal", type: "user", text: "Fix the build", time: { created: 1 } },
    {
      id: "first",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 2 },
      content: [
        {
          id: "failed",
          type: "tool",
          name: "bash",
          time: { created: 2, completed: 3 },
          state: {
            status: "error",
            input: {},
            content: [],
            structured: {},
            error: { type: "unknown", message: "build failed" },
          },
        },
      ],
    },
    { id: "continue", sessionID: session.id, type: "synthetic", text: "Continue automatically", time: { created: 4 } },
    {
      id: "second",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 5 },
      content: [],
    },
    { id: "queued-next", type: "user", text: "Next task", time: { created: 6 } },
  ])
  const input = {
    sessionID: session.id,
    messages: rows.map((row) => row.message),
    parts: Object.fromEntries(rows.map((row) => [row.message.id, row.parts])),
    busy: true,
    waiting: false,
  }
  expect(visibleProgress(input).target).toBe("Fix the build")
  expect(visibleProgress({ ...input, messages: [...input.messages].reverse() }).target).toBe("Fix the build")
  expect(visibleProgress(input).failures.map((failure) => failure.error)).toEqual(["build failed"])
  const next = adaptSessionMessages(
    session,
    [
      {
        id: "next-answer",
        type: "assistant",
        agent: "build",
        model: { id: "m", providerID: "p" },
        time: { created: 7 },
        content: [],
      },
    ],
    "queued-next",
  )
  const result = visibleProgress({ ...input, messages: [...input.messages, ...next.map((row) => row.message)] })
  expect(result.target).toBe("Next task")
  expect(
    visibleProgress({ ...input, messages: [...input.messages, ...next.map((row) => row.message)].reverse() }).target,
  ).toBe("Next task")
  expect(result.failures).toEqual([])
})

test("persisted shell completion clears a launched job without a bash_job poll", () => {
  const rows = adaptSessionMessages(session, [
    { id: "goal-shell", type: "user", text: "Run validation", time: { created: 1 } },
    {
      id: "launch-shell",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 2 },
      content: [
        {
          id: "launch-tool",
          type: "tool",
          name: "bash",
          time: { created: 2, completed: 3 },
          state: { status: "completed", input: {}, content: [], structured: { job_id: "msg_bash_job" } },
        },
      ],
    },
    {
      id: "msg_bash_job",
      type: "shell",
      callID: "launch-tool",
      command: "validate",
      output: "done",
      time: { created: 2, completed: 4 },
    },
    {
      id: "after-shell",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 5 },
      content: [],
    },
  ])
  const result = visibleProgress({
    sessionID: session.id,
    messages: rows.map((row) => row.message),
    parts: Object.fromEntries(rows.map((row) => [row.message.id, row.parts])),
    busy: false,
    waiting: false,
  })
  expect(result.target).toBe("Run validation")
  expect(result.state).toBe("idle")
  expect(result.visible).toBe(false)
  expect(result.facts.map((fact) => fact.tool)).toEqual(["bash"])
})

test("replayed unfinished jobs are unverified rather than proof of a live process", () => {
  const rows = adaptSessionMessages(session, [
    { id: "reconnect-goal", type: "user", text: "Check job", time: { created: 1 } },
    { id: "reconnect-job", type: "shell", callID: "job", command: "validate", output: "", time: { created: 2 } },
  ])
  const input = {
    sessionID: session.id,
    messages: rows.map((row) => row.message),
    parts: Object.fromEntries(rows.map((row) => [row.message.id, row.parts])),
    busy: false,
    waiting: false,
  }
  expect(visibleProgress(input).state).toBe("unverified")
  expect(visibleProgress(input).visible).toBe(true)
})

test("a live preview is separate from task activity and loses liveness on reconnect", () => {
  const rows = adaptSessionMessages(session, [
    { id: "preview-goal", type: "user", text: "Show preview", time: { created: 1 } },
    {
      id: "preview-answer",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 2 },
      content: [
        {
          id: "preview-launch",
          type: "tool",
          name: "bash",
          time: { created: 2, completed: 3 },
          state: {
            status: "completed",
            input: { background_kind: "preview" },
            content: [],
            structured: { job_id: "preview-job" },
          },
        },
      ],
    },
  ])
  const input = {
    sessionID: session.id,
    messages: rows.map((row) => row.message),
    parts: Object.fromEntries(rows.map((row) => [row.message.id, row.parts])),
    busy: false,
    waiting: false,
    liveShell: { "preview-job": true as const },
  }
  expect(visibleProgress(input).state).toBe("idle")
  expect(visibleProgress(input).preview).toBe(true)
  expect(visibleProgress(input).visible).toBe(true)
  expect(visibleProgress({ ...input, liveShell: {}, busy: true }).state).toBe("unverified")
  expect(visibleProgress({ ...input, liveShell: {} }).preview).toBe(false)
  expect(visibleProgress(input).updating).toBe(false)
  const disconnected = visibleProgress({ ...input, transportConnected: false })
  expect(disconnected.state).toBe("disconnected")
  expect(disconnected.preview).toBe(false)
  expect(disconnected.updating).toBe(false)
  expect(disconnected.visible).toBe(true)
  expect(visibleProgress({ ...input, liveShell: {} }).updating).toBe(false)
})

test("an observed job is live only on its current connected transport", () => {
  const rows = adaptSessionMessages(session, [
    { id: "live-goal", type: "user", text: "Run validation", time: { created: 1 } },
    { id: "live-job", type: "shell", callID: "job", command: "validate", output: "", time: { created: 2 } },
  ])
  const input = {
    sessionID: session.id,
    messages: rows.map((row) => row.message),
    parts: Object.fromEntries(rows.map((row) => [row.message.id, row.parts])),
    busy: false,
    waiting: false,
    liveShell: { "live-job": true as const },
    transportConnected: true,
  }
  expect(visibleProgress(input).state).toBe("tool")
  expect(visibleProgress(input).updating).toBe(true)
  expect(visibleProgress({ ...input, transportConnected: false }).state).toBe("disconnected")
  expect(visibleProgress({ ...input, transportConnected: false }).updating).toBe(false)
  expect(visibleProgress({ ...input, liveShell: {} }).state).toBe("unverified")
})

test.each(["pending", "running"] as const)("idle persisted %s tools do not claim evidence is updating", (status) => {
  const rows = adaptSessionMessages(session, [
    { id: "stale-goal", type: "user", text: "Check evidence", time: { created: 1 } },
    {
      id: "stale-answer",
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      time: { created: 2 },
      content: [
        {
          id: "stale-call",
          type: "tool",
          name: "bash",
          time: { created: 2 },
          state: status === "pending" ? { status, input: "{}" } : { status, input: {}, content: [], structured: {} },
        },
      ],
    },
  ])
  const input = {
    sessionID: session.id,
    messages: rows.map((row) => row.message),
    parts: Object.fromEntries(rows.map((row) => [row.message.id, row.parts])),
    busy: false,
    waiting: false,
    transportConnected: true,
  }
  expect(visibleProgress(input).state).toBe("unverified")
  expect(visibleProgress(input).visible).toBe(true)
  expect(visibleProgress(input).updating).toBe(false)
})
