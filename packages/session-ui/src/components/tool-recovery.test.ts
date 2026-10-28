import { expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, ToolPart } from "@zaovra-ai/sdk/v2"
import { quietToolFailures, recoveredToolFailures } from "./tool-recovery"

const user: Message = {
  id: "user",
  sessionID: "session",
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "fixture", modelID: "offline" },
}
const first: AssistantMessage = {
  id: "first",
  sessionID: "session",
  role: "assistant",
  parentID: "user",
  time: { created: 2, completed: 3 },
  finish: "tool-calls",
  agent: "build",
  mode: "build",
  providerID: "fixture",
  modelID: "offline",
  path: { cwd: "/test", root: "/test" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}
const last: AssistantMessage = { ...first, id: "last", time: { created: 4, completed: 5 }, finish: "stop" }
const failure: ToolPart = {
  id: "failure",
  messageID: first.id,
  sessionID: "session",
  type: "tool",
  tool: "edit",
  callID: "failure",
  state: {
    status: "error",
    input: { path: "app.ts", oldString: "old", newString: "fixed" },
    error: "Could not find oldString",
    time: { start: 2, end: 3 },
  },
}
const success: ToolPart = {
  ...failure,
  id: "success",
  messageID: last.id,
  callID: "success",
  state: {
    status: "completed",
    input: { path: "app.ts", oldString: " old ", newString: "fixed" },
    output: "Edited",
    title: "edit",
    metadata: {},
    time: { start: 4, end: 5 },
  },
}
function recovered(parts: Record<string, Part[]>, messages: readonly Message[] = [user, first, last], working = false) {
  return recoveredToolFailures({
    message: first,
    messages,
    parts: {
      [user.id]: [{ id: "request", messageID: user.id, sessionID: user.sessionID, type: "text", text: "Fix app.ts" }],
      ...parts,
    },
    working,
  }).map((part) => part.id)
}

test("exact edit recovery is display-only and closes only after the turn settles", () => {
  const parts = { first: [failure], last: [success] }
  expect(recovered(parts)).toEqual([failure.id])
  expect(failure.state.status).toBe("error")
  expect(recovered(parts, [user, first, last], true)).toEqual([])
  expect(recovered(parts, [user, first, last, { ...user, id: "queued", time: { created: 6 } }], true)).toEqual([])
  expect(recovered(parts, [user, first, { ...last, finish: "tool-calls" }])).toEqual([])
  expect(recovered(parts, [user, first, { ...last, time: { created: 4 } }])).toEqual([])
})

test("different target or replacement, earlier success and formatting failure do not resolve an edit", () => {
  if (success.state.status !== "completed") throw new Error("Expected completed fixture")
  const state = success.state
  for (const changed of [
    { ...success, state: { ...state, input: { ...state.input, path: "other.ts" } } },
    { ...success, state: { ...state, input: { ...state.input, newString: "unrelated" } } },
    { ...success, state: { ...state, input: { ...state.input, oldString: "different block" } } },
    { ...success, state: { ...state, input: { ...state.input, replaceAll: true } } },
    { ...success, tool: "write", state: { ...state, input: { path: "app.ts", content: "contains fixed" } } },
    { ...success, state: { ...state, time: { start: 1, end: 1 } } },
    { ...success, state: { ...state, metadata: { formatting: { failed: ["formatter"] } } } },
  ])
    expect(recovered({ first: [failure], last: [changed] })).toEqual([])
})

test("verification failures stay visible even when the exact command later succeeds", () => {
  if (failure.state.status !== "error" || success.state.status !== "completed") throw new Error("Expected fixtures")
  const input = { command: "bun test", verification: "test" }
  expect(
    recovered({
      first: [{ ...failure, tool: "bash", state: { ...failure.state, input, error: "Verification failed: test" } }],
      last: [
        {
          ...success,
          tool: "bash",
          state: { ...success.state, input, metadata: { exit: 0, verification: { exit: 0 } } },
        },
      ],
    }),
  ).toEqual([])
  expect(
    recovered({ first: [{ ...failure, state: { ...failure.state, error: "Verification failed" } }], last: [success] }),
  ).toEqual([])
})

test("uncertain effects and background or timed-out results never count as recovery", () => {
  if (failure.state.status !== "error" || success.state.status !== "completed") throw new Error("Expected fixtures")
  expect(
    recovered({
      first: [{ ...failure, state: { ...failure.state, error: "Outcome may have occurred; observe before retrying" } }],
      last: [success],
    }),
  ).toEqual([])
  expect(
    recovered({
      first: [{ ...failure, state: { ...failure.state, metadata: { phase: "mutation", reason: "target-changed" } } }],
      last: [success],
    }),
  ).toEqual([])
  for (const metadata of [{ timeout: true }, { job_id: "still-running" }, { exit: 1 }]) {
    expect(recovered({ first: [failure], last: [{ ...success, state: { ...success.state, metadata } }] })).toEqual([])
  }
})

test("no changes is neutral after completion, while unresolved operations remain errors", () => {
  if (failure.state.status !== "error") throw new Error("Expected failure")
  expect(
    recovered({
      first: [
        {
          ...failure,
          state: { ...failure.state, error: "No changes to apply: oldString and newString are identical." },
        },
      ],
    }),
  ).toEqual([failure.id])
  expect(recovered({ first: [failure] })).toEqual([])
})

test("synthetic continuation keeps request ownership and a new user request cannot recover older failures", () => {
  const synthetic = { ...user, id: "shell", time: { created: 3 } }
  const parts = {
    first: [failure],
    shell: [
      { id: "text", sessionID: "session", messageID: "shell", type: "text" as const, text: "result", synthetic: true },
    ],
    last: [success],
  }
  expect(
    recovered(
      parts,
      [last, synthetic, first, user].map((message) =>
        message.id === "last" ? { ...last, parentID: "shell" } : message,
      ),
    ),
  ).toEqual([failure.id])
  expect(
    recovered({ first: [failure], last: [success] }, [user, first, synthetic, { ...last, parentID: "shell" }]),
  ).toEqual([])
})

test("a missing exploratory read is quiet after a successful same-target creation and a normal answer", () => {
  if (failure.state.status !== "error") throw new Error("Expected failure")
  const read = {
    ...failure,
    tool: "read",
    state: {
      ...failure.state,
      input: { filePath: "missing.html" },
      error: "Unable to read missing.html",
      metadata: { readFailure: "not_found" },
    },
  }
  const created: ToolPart = {
    ...success,
    tool: "write",
    state: { ...success.state, input: { filePath: "missing.html" } },
  }
  const parts = {
    user: [
      { id: "request", messageID: user.id, sessionID: user.sessionID, type: "text" as const, text: "Build a page" },
    ],
    first: [read],
    last: [
      created,
      {
        id: "answer",
        messageID: last.id,
        sessionID: last.sessionID,
        type: "text" as const,
        text: "The page is ready.",
      },
    ],
  }
  const input = { message: last, messages: [user, first, last], parts, working: false }
  expect(recoveredToolFailures(input)).toEqual([])
  expect(quietToolFailures(input).map((part) => part.id)).toEqual([read.id])
  expect(read.state.error).toBe("Unable to read missing.html")
  expect(quietToolFailures({ ...input, working: true })).toEqual([])
  for (const finish of ["interrupted", "stopped", "tool-calls"])
    expect(quietToolFailures({ ...input, messages: [user, first, { ...last, finish }] })).toEqual([])
  expect(quietToolFailures({ ...input, parts: { ...parts, last: [success] } })).toEqual([])
  expect(quietToolFailures({ ...input, parts: { ...parts, last: parts.last.slice(1) } })).toEqual([])
  expect(
    quietToolFailures({
      ...input,
      messages: [user, first, { ...last, error: { name: "UnknownError", data: { message: "failed" } } }],
    }),
  ).toEqual([])
})

test("exploration cannot hide verification, permissions, uncertain effects, a final failed step or another turn", () => {
  if (failure.state.status !== "error" || success.state.status !== "completed") throw new Error("Expected fixtures")
  const read = {
    ...failure,
    tool: "read",
    state: {
      ...failure.state,
      input: { filePath: "missing.html" },
      error: "Unable to read missing.html",
      metadata: { readFailure: "not_found" },
    },
  }
  const answer: Part = { id: "answer", messageID: last.id, sessionID: last.sessionID, type: "text", text: "Done" }
  const created: ToolPart = {
    ...success,
    tool: "write",
    state: { ...success.state, input: { filePath: "missing.html" } },
  }
  const parts = {
    user: [{ ...answer, id: "request", messageID: user.id, text: "Build a page" }],
    first: [read],
    last: [created, answer],
  }
  const input = { message: last, messages: [user, first, last], parts, working: false }
  for (const error of [
    "File not found; partial result",
    "File not found; timed out",
    "Permission denied",
    "Verification failed: file not found",
  ])
    expect(
      quietToolFailures({ ...input, parts: { ...parts, first: [{ ...read, state: { ...read.state, error } }] } }),
    ).toEqual([])
  for (const metadata of [
    { phase: "mutation", reason: "target-changed" },
    { verification: true },
    { timeout: true },
    { readFailure: "permission" },
    { readFailure: "unknown" },
    { reason: "not_found" },
    { phase: "permission", reason: "PermissionV2.BlockedError" },
    {},
  ])
    expect(
      quietToolFailures({ ...input, parts: { ...parts, first: [{ ...read, state: { ...read.state, metadata } }] } }),
    ).toEqual([])
  for (const metadata of [
    { exit: 1, verification: true },
    { timeout: true },
    { job_id: "active" },
    { formatting: { failed: ["formatter"] } },
  ])
    expect(
      quietToolFailures({
        ...input,
        parts: {
          ...parts,
          last: [{ ...created, state: { ...success.state, input: { filePath: "missing.html" }, metadata } }, answer],
        },
      }),
    ).toEqual([])
  expect(quietToolFailures({ ...input, parts: { ...parts, first: [success], last: [read, answer] } })).toEqual([])
  expect(
    quietToolFailures({
      ...input,
      parts: {
        ...parts,
        first: [
          read,
          {
            ...failure,
            id: "mutation",
            state: { ...failure.state, input: { ...failure.state.input, path: "other.ts" } },
          },
        ],
      },
    }),
  ).toEqual([])
  expect(
    quietToolFailures({
      ...input,
      messages: [
        user,
        first,
        { ...user, id: "new", time: { created: 4 } },
        { ...last, parentID: "new", time: { created: 5, completed: 6 } },
      ],
    }),
  ).toEqual([])
})

test("required missing reads need later evidence for the same agent and path", () => {
  if (failure.state.status !== "error" || success.state.status !== "completed") throw Error("fixtures")
  const missing: ToolPart = {
    ...failure,
    tool: "read",
    state: {
      ...failure.state,
      input: { path: "customer-spec.md" },
      error: "Unable to read customer-spec.md",
      metadata: { readFailure: "not_found" },
    },
  }
  const answer: Part = {
    id: "answer",
    messageID: last.id,
    sessionID: last.sessionID,
    type: "text",
    text: "缺少必需规格文件，无法完成，请提供。",
  }
  const check = (tool: string, path: string, agent = last.agent) =>
    quietToolFailures({
      message: last,
      messages: [user, first, { ...last, agent }],
      parts: {
        user: [
          {
            ...answer,
            id: "request",
            messageID: user.id,
            text: "必须先读取 customer-spec.md，缺失时提醒我，不得自编。",
          },
        ],
        first: [missing],
        last: [{ ...success, tool, state: { ...success.state, input: { path } } }, answer],
      },
      working: false,
    })
  expect(check("list", ".")).toEqual([])
  expect(check("write", "other.md")).toEqual([])
  expect(check("read", "other.md")).toEqual([])
  expect(check("write", "customer-spec.md")).toEqual([])
  expect(check("read", "customer-spec.md").map((part) => part.id)).toEqual([missing.id])
  expect(check("write", "customer-spec.md", "other-agent")).toEqual([])
})

test("named source reads stay unresolved after placeholder writes, including raw data and amendments", () => {
  if (failure.state.status !== "error" || success.state.status !== "completed") throw Error("fixtures")
  const missing: ToolPart = {
    ...failure,
    tool: "read",
    state: { ...failure.state, input: { path: "docs/customer-spec.md" }, metadata: { readFailure: "not_found" } },
  }
  const answer: Part = { id: "answer", sessionID: user.sessionID, messageID: last.id, type: "text", text: "已完成" }
  const text = (body: string): Extract<Part, { type: "text" }> => ({
    ...answer,
    id: "request",
    messageID: user.id,
    text: body,
  })
  const check = (
    requests: Part[],
    tool = "write",
    messages: readonly Message[] = [user, first, last],
    extra: Record<string, Part[]> = {},
  ) => {
    const input = {
      message: last,
      messages,
      working: false,
      parts: {
        user: requests,
        first: [missing],
        last: [{ ...success, tool, state: { ...success.state, input: { path: "docs/customer-spec.md" } } }, answer],
        ...extra,
      },
    }
    return { quiet: quietToolFailures(input), recovered: recoveredToolFailures(input) }
  }
  for (const request of [
    "必须读取 customer-spec.md，缺少时不要自编",
    "先读 docs/customer-spec.md",
    "读取 DOCS\\CUSTOMER-SPEC.MD",
    "原资料如下：\n```data\ncustomer-spec.md\n```",
    "创建页面；\n> customer-spec.md",
  ]) {
    expect(check([text(request)])).toEqual({ quiet: [], recovered: [] })
    expect(check([text(request)], "read").quiet).toEqual([missing])
  }
  expect(check([text("做个小游戏")]).quiet).toEqual([missing])
  expect(check([])).toEqual({ quiet: [], recovered: [] })
  expect(check([{ ...text("必须读取 customer-spec.md"), metadata: { zaovraRequestText: "做个小游戏" } }])).toEqual({
    quiet: [],
    recovered: [],
  })
  expect(check([{ ...text("做个小游戏"), synthetic: true }])).toEqual({ quiet: [], recovered: [] })
  expect(
    check([
      {
        ...text("/task"),
        metadata: { zaovraRequestText: "必须读取 customer-spec.md", zaovraRequestInvocation: "/task" },
      },
    ]),
  ).toEqual({ quiet: [], recovered: [] })
  expect(
    check([
      {
        ...text("/game customer-spec.md"),
        metadata: {
          zaovraRequestText: "做个小游戏",
          zaovraRequestInvocation: "/game customer-spec.md",
        },
      },
    ]),
  ).toEqual({ quiet: [], recovered: [] })
  expect(
    check([{ ...text("做个小游戏"), metadata: { zaovraRequestText: "做个小游戏", zaovraRequestSubtask: true } }]),
  ).toEqual({ quiet: [], recovered: [] })
  const original = { ...user, id: "original", time: { created: 0 } }
  expect(
    check([text("补充要求：先读 customer-spec.md")], "write", [original, user, first, last], {
      original: [{ ...text("做个小游戏"), messageID: original.id }],
    }),
  ).toEqual({ quiet: [], recovered: [] })
  const queued = { ...user, id: "queued", time: { created: 3.5 } }
  expect(
    check([text("必须读取 customer-spec.md")], "write", [user, first, queued, last], {
      queued: [{ ...text("做个小游戏"), messageID: queued.id }],
    }),
  ).toEqual({ quiet: [], recovered: [] })
})

test("a named filename spanning request clause punctuation still needs its original read", () => {
  if (failure.state.status !== "error" || success.state.status !== "completed") throw Error("fixtures")
  for (const path of ["docs/customer; spec.md", "docs/客户。spec.md"]) {
    expect(
      quietToolFailures({
        message: last,
        messages: [user, first, last],
        working: false,
        parts: {
          user: [
            {
              id: "request",
              messageID: user.id,
              sessionID: user.sessionID,
              type: "text",
              text: `必须读取 ${path}，不能自编`,
            },
          ],
          first: [
            {
              ...failure,
              tool: "read",
              state: { ...failure.state, input: { path }, metadata: { readFailure: "not_found" } },
            },
          ],
          last: [
            { ...success, tool: "write", state: { ...success.state, input: { path } } },
            { id: "answer", messageID: last.id, sessionID: last.sessionID, type: "text", text: "已完成" },
          ],
        },
      }),
    ).toEqual([])
  }
})
