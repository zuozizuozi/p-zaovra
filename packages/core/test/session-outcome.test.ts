import { expect, test } from "bun:test"
import { DateTime } from "effect"
import path from "node:path"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { SessionOutcome } from "@zaovra-ai/core/session/outcome"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionSchema } from "@zaovra-ai/core/session/schema"

const assistant: SessionMessage.Assistant = {
  id: SessionMessage.ID.make("msg_result"),
  type: "assistant",
  agent: "build",
  model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
  content: [],
  finish: "stop",
  time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
}

test("execution diagnosis is restricted to inline parse failures", () => {
  expect(
    SessionOutcome.executionIssue(
      "node --input-type=module -e 'broken'",
      "file:///tmp/[eval1]:1\nSyntaxError: Unexpected token",
    ),
  ).toBe("not-run")
  expect(SessionOutcome.executionIssue("node test.mjs", "[eval1]:1\nSyntaxError: Unexpected token")).toBeUndefined()
  expect(
    SessionOutcome.executionIssue("node -e 'import()'", "file:///tmp/product.mjs:1\nSyntaxError: Unexpected token"),
  ).toBeUndefined()
  expect(SessionOutcome.executionIssue("node -e 'assert()'", "[eval1]:1\nAssertionError: broken")).toBeUndefined()
})

test("verification commands have a single observable exit status", () => {
  for (const command of [
    "npm test",
    "node verify.mjs",
    '& "C:/Program Files/node.exe" "verify.mjs"',
    "node -e 'console.log(1); console.log(2)'",
  ])
    expect(SessionOutcome.singleCommand(command)).toBe(true)
  for (const command of [
    "npm test; echo done",
    "npm test | tail -1",
    "npm test && npm run build",
    "npm test 2>&1",
    '{"checks":[]}',
    "npm test\nnpm run build",
  ])
    expect(SessionOutcome.singleCommand(command)).toBe(false)
})

test("input rejection is not a product failure or a spent shell execution attempt", () => {
  const tool: SessionMessage.AssistantTool = {
    type: "tool",
    id: "rejected",
    name: "bash",
    time: assistant.time,
    state: {
      status: "error",
      content: [],
      structured: {},
      input: { command: 'Write-Output "report"', verification_report: { checks: [] } },
      error: { type: "unknown", message: "Invalid tool input: Expected boolean" },
    },
  }
  expect(SessionOutcome.derive([{ ...assistant, content: [tool] }], false).checks).toMatchObject([
    { execution: "not-run" },
  ])
  expect(SessionOutcome.derive([{ ...assistant, content: [tool] }], false).state).toBe("completed_unverified")
  expect(SessionOutcome.recoveryFailures([{ ...assistant, content: [tool, tool, tool, tool] }])).toBe(0)
})

test("a corrected check resolves rejected input with relative targets in the session directory", () => {
  const cwd = path.resolve("workspace")
  const target = path.join(cwd, "test.js")
  const error: SessionMessage.AssistantTool = {
    type: "tool",
    id: "invalid",
    name: "bash",
    time: assistant.time,
    state: {
      status: "error",
      content: [],
      structured: {},
      input: { command: "report", verification_report: { checks: [] }, verification_targets: ["test.js"] },
      error: { type: "unknown", message: "Invalid tool input: boolean required" },
    },
  }
  const pass: SessionMessage.AssistantTool = {
    type: "tool",
    id: "actual",
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      content: [],
      input: { command: "node test.js" },
      structured: {
        verification: {
          kind: "test",
          command: "node test.js",
          cwd,
          callID: "actual",
          exit: 0,
          targets: [{ path: target, digest: "same" }],
        },
      },
    },
  }
  const outcome = SessionOutcome.derive(
    [{ ...assistant, content: [error, pass] }],
    false,
    undefined,
    [{ path: target, digest: "same" }],
    [],
    undefined,
    cwd,
  )
  expect(outcome.state).toBe("completed_verified")
  expect(outcome.checks[0].supersededBy).toBe("actual")
})

test("changed failed assertions cannot be certified by a passing edited test", () => {
  const run = (id: string, exit: number, source: string, assertion: string): SessionMessage.AssistantTool => ({
    type: "tool",
    id,
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: { command: "npm test" },
      content: [],
      structured: {
        exit,
        verification: {
          kind: "test",
          command: "npm test",
          callID: id,
          exit,
          targets: [
            { path: "/src/csv.js", digest: source },
            { path: "/test/csv.test.js", digest: assertion },
          ],
          assertions: [{ path: "/test/csv.test.js", digest: assertion }],
        },
      },
    },
  })
  const evaluate = (source: string, assertion: string) =>
    SessionOutcome.derive(
      [{ ...assistant, content: [run("fail", 1, "buggy", "original"), run("pass", 0, source, assertion)] }],
      false,
      undefined,
      [
        { path: "/src/csv.js", digest: source },
        { path: "/test/csv.test.js", digest: assertion },
      ],
      [],
    )
  expect(evaluate("fixed", "original").state).toBe("completed_verified")
  expect(evaluate("buggy", "weakened").state).toBe("completed_unverified")
  expect(evaluate("buggy", "weakened").missing.join(" ")).toContain("Failed assertion changed")
  expect(evaluate("fixed", "weakened").state).toBe("completed_unverified")
  const repaired = SessionOutcome.derive(
    [
      {
        ...assistant,
        content: [
          run("fail", 1, "buggy", "original"),
          run("repair", 0, "fixed", "original"),
          run("extend", 0, "fixed", "extended"),
        ],
      },
    ],
    false,
    undefined,
    [
      { path: "/src/csv.js", digest: "fixed" },
      { path: "/test/csv.test.js", digest: "extended" },
    ],
    [],
  )
  expect(repaired.state).toBe("completed_verified")
  const unrelated: SessionMessage.AssistantTool = {
    type: "tool",
    id: "unrelated",
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: { command: "node other.js" },
      content: [],
      structured: {
        verification: {
          kind: "test",
          command: "node other.js",
          callID: "unrelated",
          exit: 0,
          targets: [{ path: "/other.js", digest: "passing" }],
        },
      },
    },
  }
  const restoredWithoutRerun = SessionOutcome.derive(
    [
      {
        ...assistant,
        content: [run("failed", 1, "buggy", "original"), run("weakened", 0, "buggy", "weakened"), unrelated],
      },
    ],
    false,
    undefined,
    [
      { path: "/src/csv.js", digest: "buggy" },
      { path: "/test/csv.test.js", digest: "original" },
      { path: "/other.js", digest: "passing" },
    ],
    [],
  )
  expect(restoredWithoutRerun.state).toBe("completed_unverified")
  expect(restoredWithoutRerun.missing.join(" ")).toContain("not reverified by an unchanged passing execution")
})

test("same command resolves a real failure after expanding its target scope with unchanged assertions", () => {
  const original = { path: "/test/ledger.test.js", digest: "original" }
  const source = { path: "/src/ledger.js", digest: "fixed" }
  const check = (
    id: string,
    exit: number,
    targets: (typeof original)[],
    digest = "original",
  ): SessionMessage.AssistantTool => ({
    type: "tool",
    id,
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: { command: "npm test", verification_targets: targets.map((target) => target.path) },
      content: [],
      structured: {
        verification: {
          kind: "test",
          command: "npm test",
          callID: id,
          cwd: "/",
          exit,
          targets,
          assertions: [{ ...original, digest }],
        },
      },
    },
  })
  const evaluate = (digest = "original") =>
    SessionOutcome.derive(
      [
        {
          ...assistant,
          content: [check("failed", 1, [original]), check("expanded", 0, [{ ...original, digest }, source], digest)],
        },
      ],
      false,
      undefined,
      [{ ...original, digest }, source],
      [],
    )
  expect(evaluate().state).toBe("completed_verified")
  expect(evaluate().checks.find((check) => check.callID === "failed")?.supersededBy).toBe("expanded")
  expect(evaluate("weakened").state).not.toBe("completed_verified")
})

test("closing review gates every original clause, known gaps and stale evidence", () => {
  const user: SessionMessage.User = {
    type: "user",
    id: SessionMessage.ID.make("msg_review_user"),
    text: "保留全部自有字符串键；失败不修改输入。",
    time: assistant.time,
  }
  const marker: SessionMessage.Synthetic = {
    type: "synthetic",
    sessionID: SessionSchema.ID.make("ses_review"),
    id: SessionMessage.ID.make("msg_review_marker"),
    text: "Verification closing review: {}",
    time: assistant.time,
  }
  const targets = [{ path: "/src.js", digest: "current" }]
  const check: SessionMessage.AssistantTool = {
    type: "tool",
    id: "checked",
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: {
        verification: {
          kind: "test",
          command: "npm test",
          callID: "checked",
          exit: 0,
          targets,
          requirements: ["tested keys"],
        },
      },
    },
  }
  const items = [1, 2].map((requirement) => ({
    requirement,
    evidence: ["checked"],
    status: "verified" as const,
    note: "Assertions executed",
  }))
  const evaluate = (
    reviewItems = items,
    unverified: string[] = [],
    current = targets,
    userMessageID: string = user.id,
    notes: { text: string; requirements: number[] }[] = [],
  ) =>
    SessionOutcome.derive(
      [
        user,
        marker,
        {
          ...assistant,
          content: [
            check,
            {
              type: "tool",
              id: "review",
              name: "verification_review",
              time: assistant.time,
              state: {
                status: "completed",
                input: {},
                content: [],
                structured: { review: { userMessageID, items: reviewItems, unverified, notes } },
              },
            },
          ],
        },
      ],
      false,
      undefined,
      current,
      [],
    )
  expect(evaluate().state).toBe("completed_verified")
  expect(evaluate(items, ["Only enumerable keys supported"]).state).toBe("completed_unverified")
  expect(evaluate(items.slice(0, 1)).missing.join(" ")).toContain("requirement 2 unverified")
  expect(evaluate([...items, items[0]]).state).toBe("completed_unverified")
  expect(evaluate(items.map((item) => ({ ...item, evidence: ["invented"] }))).state).toBe("completed_unverified")
  expect(evaluate(items.map((item) => ({ ...item, evidence: ["invented"] }))).missing.join(" ")).toContain(
    "unknown check callID invented",
  )
  expect(evaluate(items, [], [{ path: "/src.js", digest: "changed" }]).state).toBe("completed_unverified")
  expect(evaluate(items, [], [{ path: "/src.js", digest: "changed" }]).missing.join(" ")).toContain("stale check")
  expect(evaluate(items, [], targets, "older-user").state).toBe("completed_unverified")
  expect(evaluate(items, [], targets, user.id, [{ text: "Other platforms not tested", requirements: [] }]).state).toBe(
    "completed_verified",
  )
  expect(
    evaluate(items, ["Non-enumerable keys unsupported"], targets, user.id, [
      { text: "Key coverage limitation", requirements: [1] },
    ]).state,
  ).toBe("completed_unverified")
  expect(
    evaluate(items, [], targets, user.id, [
      { text: "Symbols are outside the requested string-key contract", requirements: [1] },
    ]).state,
  ).toBe("completed_verified")
  expect(
    evaluate(items, [], [{ path: "/src.js", digest: "changed" }], user.id, [
      { text: "Previously verified", requirements: [1] },
    ]).state,
  ).toBe("completed_unverified")
  expect(evaluate(items.slice(1), [], targets, user.id, [{ text: "Keys outside scope", requirements: [] }]).state).toBe(
    "completed_unverified",
  )
  expect(evaluate(items, ["Known gap"], targets, user.id, [{ text: "Just a note", requirements: [] }]).state).toBe(
    "completed_unverified",
  )
  expect(evaluate(items, [], targets, user.id, [{ text: "Uncertain scope", requirements: [999] }]).state).toBe(
    "completed_unverified",
  )
  expect(
    SessionOutcome.derive([user, marker, { ...assistant, content: [check] }], false, undefined, targets, []).state,
  ).toBe("completed_unverified")
})

test("historical execution proves process facts, never substitutes for current functional evidence", () => {
  const user: SessionMessage.User = {
    type: "user",
    id: SessionMessage.ID.make("msg_process_user"),
    text: "先运行原测试再修改；修复全部自有字符串键。",
    time: assistant.time,
  }
  const baseline: SessionMessage.AssistantTool = {
    type: "tool",
    id: "baseline",
    name: "bash",
    time: { created: DateTime.makeUnsafe(1), ran: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
    state: { status: "completed", input: { command: "node original-test.mjs" }, content: [], structured: { exit: 1 } },
  }
  const edit: SessionMessage.AssistantTool = {
    ...baseline,
    id: "repair",
    name: "edit",
    time: { created: DateTime.makeUnsafe(4), ran: DateTime.makeUnsafe(5), completed: DateTime.makeUnsafe(6) },
    state: { status: "completed", input: {}, content: [], structured: {} },
  }
  const targets = [{ path: "/src.js", digest: "fixed" }]
  const check: SessionMessage.AssistantTool = {
    ...baseline,
    id: "current",
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: {
        exit: 0,
        verification: {
          kind: "test",
          command: "node test.mjs",
          callID: "current",
          exit: 0,
          targets,
          requirements: ["all keys"],
        },
      },
    },
  }
  const evaluate = (
    history = [{ callID: "baseline", exit: 1, before: "repair" }],
    evidence = ["current"],
    current = targets,
    original: SessionMessage.AssistantTool = baseline,
    later: SessionMessage.AssistantTool = edit,
    kind: "process" | "result" = "process",
  ) =>
    SessionOutcome.derive(
      [
        user,
        { ...assistant, content: [original, later, check] },
        {
          type: "synthetic",
          sessionID: SessionSchema.ID.make("ses_process"),
          id: SessionMessage.ID.make("msg_process_marker"),
          text: "Verification closing review: {}",
          time: assistant.time,
        },
        {
          ...assistant,
          content: [
            {
              ...baseline,
              id: "review",
              name: "verification_review",
              state: {
                status: "completed",
                input: {},
                content: [],
                structured: {
                  review: {
                    userMessageID: user.id,
                    items: [
                      {
                        requirement: 1,
                        kind,
                        history,
                        evidence: [],
                        status: "verified",
                        note: "Original test failed before repair",
                      },
                      { requirement: 2, evidence, status: "verified", note: "Current suite covers every key" },
                    ],
                    unverified: [],
                    notes: [{ text: "No cross-platform claim", requirements: [] }],
                  },
                },
              },
            },
          ],
        },
      ],
      false,
      undefined,
      current,
      [],
    )
  expect(evaluate().state).toBe("completed_verified")
  expect(evaluate([{ callID: "baseline", exit: 0, before: "repair" }]).state).toBe("completed_unverified")
  expect(evaluate([{ callID: "event-id", exit: 1, before: "repair" }]).state).toBe("completed_unverified")
  expect(evaluate([{ callID: "baseline", exit: 1, before: "baseline" }]).state).toBe("completed_unverified")
  expect(evaluate([]).state).toBe("completed_unverified")
  expect(evaluate(undefined, []).state).toBe("completed_unverified")
  expect(evaluate(undefined, ["baseline"]).state).toBe("completed_unverified")
  expect(evaluate(undefined, undefined, [{ path: "/src.js", digest: "changed" }]).state).toBe("completed_unverified")
  expect(evaluate(undefined, undefined, undefined, undefined, undefined, "result").state).toBe("completed_unverified")
  expect(
    evaluate(undefined, undefined, undefined, {
      ...baseline,
      state: {
        status: "completed",
        input: {},
        content: [],
        structured: { exit: 1, timeout: true },
      },
    }).state,
  ).toBe("completed_unverified")
  expect(evaluate(undefined, undefined, undefined, { ...baseline, provider: { executed: true } }).state).toBe(
    "completed_unverified",
  )
  expect(
    evaluate(undefined, undefined, undefined, undefined, {
      ...edit,
      time: {
        created: DateTime.makeUnsafe(1),
        ran: DateTime.makeUnsafe(2),
        completed: DateTime.makeUnsafe(6),
      },
    }).state,
  ).toBe("completed_unverified")
  expect(
    evaluate(undefined, undefined, undefined, undefined, { ...edit, time: { created: DateTime.makeUnsafe(4) } }).state,
  ).toBe("completed_unverified")
  // Evidence from an older durable request cannot be reused for the current one.
  expect(SessionOutcome.executions([{ ...assistant, content: [baseline] }, user])).toEqual([])
})

test("a different command can explicitly revalidate a failure only with unchanged original assertions", () => {
  const targets = [
    { path: "/src.js", digest: "fixed" },
    { path: "/test/check.js", digest: "original" },
  ]
  const tool = (
    id: string,
    exit: number,
    assertions: typeof targets,
    replaces: string[] = [],
  ): SessionMessage.AssistantTool => ({
    id,
    name: "bash",
    type: "tool",
    time: assistant.time,
    state: {
      status: "completed",
      input: { command: id, verification_replaces: replaces },
      content: [],
      structured: {
        verification: { kind: "test", cwd: "/", callID: id, command: id, exit, targets, assertions },
      },
    },
  })
  const first = tool("original-command", 1, [targets[1]])
  const evaluate = (second: SessionMessage.AssistantTool) =>
    SessionOutcome.derive([{ ...assistant, content: [first, second] }], false, undefined, targets, [])
  expect(evaluate(tool("new-command", 0, [targets[1]])).state).toBe("failed")
  expect(evaluate(tool("new-command", 0, [targets[1]], [first.id])).state).toBe("completed_verified")
  expect(evaluate(tool("new-command", 0, [], [first.id])).state).toBe("failed")
  expect(evaluate(tool("new-command", 0, [{ ...targets[1], digest: "weakened" }], [first.id])).state).toBe("failed")
})

test("a passing suite resets the shell failure count without a legacy single-check record", () => {
  const content: SessionMessage.AssistantTool[] = [1, 0].map((exit) => ({
    type: "tool",
    id: `suite-${exit}`,
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: {
        exit,
        verifications: [{ kind: "test", command: "node verify.mjs", exit, callID: `suite-${exit}` }],
      },
    },
  }))
  expect(SessionOutcome.recoveryFailures([{ ...assistant, content: content.slice(0, 1) }])).toBe(1)
  expect(SessionOutcome.recoveryFailures([{ ...assistant, content }])).toBe(0)
})

test("replacement evidence cannot hide failures outside its scope or survive a failed rerun", () => {
  const targets = [{ path: "/module.mjs", digest: "current" }]
  const check = (id: string, exit: number, extra: Record<string, unknown> = {}): SessionMessage.AssistantTool => ({
    id,
    type: "tool",
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: { command: id },
      content: [],
      structured: {
        verification: { kind: "test", command: id, callID: id, cwd: "/", exit, targets, ...extra },
      },
    },
  })
  const derive = (content: SessionMessage.AssistantTool[], current = targets) =>
    SessionOutcome.derive([{ ...assistant, content }], false, undefined, current, [])
  const setup = check("setup", 1, { execution: "not-run" })
  expect(derive([setup]).state).toBe("completed_unverified")
  expect(derive([setup, check("script", 0)])).toMatchObject({
    state: "completed_verified",
    checks: [{ supersededBy: "script" }, { exit: 0 }],
  })
  for (const extra of [{ kind: "build" }, { cwd: "/other" }, { targets: [{ path: "/other.mjs", digest: "current" }] }])
    expect(derive([setup, check("script", 0, extra)]).checks[0].supersededBy).toBeUndefined()
  expect(
    derive([setup, check("script", 0)], [{ path: "/module.mjs", digest: "changed" }]).checks[0].supersededBy,
  ).toBeUndefined()
  expect(derive([check("assertion", 1), check("script", 0)]).state).toBe("failed")
  expect(
    derive([check("assertion", 1), check("assertion", -1, { execution: "invalid-report" }), check("script", 0)]).state,
  ).toBe("failed")
  expect(derive([check("assertion", 1, { supersededBy: "script" }), check("script", 0)]).state).toBe("failed")
  expect(derive([setup, check("script", 0), check("script", 1)])).toMatchObject({
    state: "failed",
    checks: [{ supersededBy: undefined }, { exit: 1 }],
  })
})

test("green checks require current requirement coverage for an engineering request", () => {
  const user: SessionMessage.User = {
    type: "user",
    id: SessionMessage.ID.make("msg_request"),
    text: "Support CSV round trips including empty fields",
    time: assistant.time,
  }
  const targets = [{ path: "/module.mjs", digest: "current" }]
  const run = (requirements?: string[], current = targets) =>
    SessionOutcome.derive(
      [
        user,
        {
          ...assistant,
          content: [
            {
              type: "tool",
              id: "suite",
              name: "bash",
              time: assistant.time,
              state: {
                status: "completed",
                input: {},
                content: [],
                structured: {
                  verification: {
                    kind: "test",
                    command: "node verify.mjs",
                    callID: "suite",
                    exit: 0,
                    targets,
                    ...(requirements ? { requirements } : {}),
                  },
                },
              },
            },
          ],
        },
      ],
      false,
      undefined,
      current,
      [],
    )
  expect(run()).toMatchObject({ state: "completed_unverified", missing: ["requirements"] })
  expect(run(["  "]).state).toBe("completed_unverified")
  expect(run(["round trips include one empty field"]).state).toBe("completed_verified")
  expect(run(["round trips"], [{ path: "/module.mjs", digest: "changed" }]).missing).toContain("requirements")
})

test("live background shells do not block completion, but lost ownership remains unknown", () => {
  const shell: SessionMessage.Shell = {
    id: SessionMessage.ID.make("msg_preview"),
    type: "shell",
    callID: "preview",
    command: "preview",
    output: "",
    time: { created: DateTime.makeUnsafe(1) },
  }
  const messages = [shell, assistant]
  expect(SessionOutcome.derive(messages, false, undefined, [], [], new Set([shell.id]))).toMatchObject({
    state: "completed_unverified",
    outcomeUnknown: false,
  })
  expect(SessionOutcome.derive(messages, false, undefined, [], [], new Set(["another-preview"]))).toMatchObject({
    state: "interrupted",
    outcomeUnknown: true,
  })
  expect(SessionOutcome.derive(messages, false)).toMatchObject({ state: "interrupted", outcomeUnknown: true })
})
test("a normal model stop does not claim engineering verification", () => {
  expect(SessionOutcome.derive([assistant], false).state).toBe("completed_unverified")
  expect(SessionOutcome.derive([assistant], true).state).toBe("running")
  expect(SessionOutcome.derive([{ ...assistant, time: { created: DateTime.makeUnsafe(1) } }], false)).toMatchObject({
    state: "interrupted",
    outcomeUnknown: true,
  })
})

test("standalone module tests satisfy missing acceptance without inventing a new check kind", () => {
  const targets = [{ path: "/module.mjs", digest: "current" }]
  const content: SessionMessage.AssistantTool[] = [
    {
      type: "tool",
      id: "suite",
      name: "bash",
      time: assistant.time,
      state: {
        status: "completed",
        input: {},
        content: [],
        structured: {
          verification: { kind: "test", command: "node --test", callID: "suite", exit: 0, targets },
        },
      },
    },
  ]
  expect(SessionOutcome.derive([{ ...assistant, content }], false, undefined, targets, [])).toMatchObject({
    state: "completed_verified",
    missing: [],
  })
  expect(
    SessionOutcome.derive(
      [{ ...assistant, content }],
      false,
      undefined,
      [{ path: "/module.mjs", digest: "changed" }],
      [],
    ).missing,
  ).toEqual(["acceptance"])
  content[0] = {
    ...content[0],
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: { verification: { kind: "syntax", command: "node --check", callID: "suite", exit: 0, targets } },
    },
  }
  expect(SessionOutcome.derive([{ ...assistant, content }], false, undefined, targets, []).state).toBe(
    "completed_unverified",
  )
})
test("checks are tied to the current snapshot, and later failure overrides earlier success", () => {
  const tools: SessionMessage.AssistantTool[] = ["build", "test", "lint"].map((kind) => ({
    id: kind,
    type: "tool",
    name: "bash",
    time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: { verification: { kind, command: `bun run ${kind}`, exit: 0, snapshot: "tree_a", callID: kind } },
    },
  }))
  const completed = { ...assistant, content: tools }
  expect(SessionOutcome.derive([completed], false, "tree_a").state).toBe("completed_verified")
  expect(SessionOutcome.derive([completed], false, "tree_b").state).toBe("completed_unverified")
  const failed: SessionMessage.AssistantTool = {
    ...tools[0],
    id: "build_again",
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: { verification: { kind: "build", command: "bun run build", exit: -1, callID: "build_again" } },
    },
  }
  expect(SessionOutcome.derive([{ ...completed, content: [...tools, failed] }], false, "tree_a").state).toBe("failed")
})

test("a later errored verification invalidates an earlier successful check", () => {
  const previous: SessionMessage.AssistantTool = {
    id: "old",
    time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    type: "tool",
    name: "bash",
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: {
        verification: { kind: "test", command: "bun test", exit: 0, snapshot: "tree", callID: "old" },
      },
    },
  }
  const failed: SessionMessage.AssistantTool = {
    id: "new",
    time: { created: DateTime.makeUnsafe(3), completed: DateTime.makeUnsafe(4) },
    type: "tool",
    name: "bash",
    state: {
      status: "error",
      input: { command: "bun test" },
      content: [],
      structured: {},
      error: { type: "unknown", message: "Interrupted" },
    },
  }
  expect(SessionOutcome.derive([{ ...assistant, content: [previous, failed] }], false, "tree")).toMatchObject({
    state: "failed",
    checks: [{ kind: "test", exit: -1, callID: "new" }],
  })
})

test("HTML acceptance binds syntax, startup and interaction to the same current artifact", () => {
  const target = { path: "C:/desktop/game.html", digest: "game-v1" }
  const checks: SessionMessage.AssistantTool[] = ["syntax", "smoke", "interaction"].map((kind) => ({
    id: kind,
    type: "tool",
    name: "bash",
    time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: {
        verification: {
          kind,
          command: `check-${kind}`,
          exit: 0,
          callID: kind,
          targets: [target],
        },
      },
    },
  }))
  expect(
    SessionOutcome.derive([{ ...assistant, content: checks.slice(0, 2) }], false, undefined, [target], []).state,
  ).toBe("completed_unverified")
  expect(SessionOutcome.derive([{ ...assistant, content: checks }], false, undefined, [target], []).state).toBe(
    "completed_verified",
  )
  expect(
    SessionOutcome.derive([{ ...assistant, content: checks }], false, undefined, [target], ["build", "test"]),
  ).toMatchObject({ state: "completed_unverified", missing: ["build", "test"] })
  const suite = {
    ...checks[0],
    id: "suite",
    state: {
      status: "completed" as const,
      input: { command: "node verify.js", verification_report: true },
      content: [],
      structured: {
        verifications: ["syntax", "smoke", "interaction"].map((kind) => ({
          kind,
          command: "node verify.js",
          exit: 0,
          callID: "suite",
          targets: [target],
        })),
      },
    },
  }
  expect(SessionOutcome.derive([{ ...assistant, content: [suite] }], false, undefined, [target], []).state).toBe(
    "completed_verified",
  )
  const reduced = {
    ...suite,
    id: "reduced",
    state: {
      ...suite.state,
      structured: {
        verifications: suite.state.structured.verifications
          .slice(0, 2)
          .map((check) => ({ ...check, callID: "reduced" })),
      },
    },
  }
  expect(
    SessionOutcome.derive([{ ...assistant, content: [suite, reduced] }], false, undefined, [target], []),
  ).toMatchObject({ state: "completed_unverified", missing: ["interaction: C:/desktop/game.html"] })
  const full = {
    ...suite,
    state: {
      ...suite.state,
      structured: {
        verifications: ["syntax", "smoke", "interaction", "build", "test"].map((kind) => ({
          ...suite.state.structured.verifications[0],
          kind,
        })),
      },
    },
  }
  expect(
    SessionOutcome.derive([{ ...assistant, content: [full] }], false, undefined, [target], ["build", "test"]).state,
  ).toBe("completed_verified")
  expect(
    SessionOutcome.derive(
      [{ ...assistant, content: [suite] }],
      false,
      undefined,
      [{ ...target, digest: "changed" }],
      [],
    ).state,
  ).toBe("completed_unverified")
  const preview: SessionMessage.Shell = {
    id: SessionMessage.ID.make("msg_preview"),
    type: "shell",
    callID: "preview",
    command: "preview",
    output: "",
    time: { created: DateTime.makeUnsafe(1) },
  }
  expect(
    SessionOutcome.derive(
      [preview, { ...assistant, content: checks }],
      false,
      undefined,
      [target],
      [],
      new Set([preview.id]),
    ).state,
  ).toBe("completed_verified")
  expect(
    SessionOutcome.derive([preview, { ...assistant, content: checks }], false, undefined, [target], []).state,
  ).toBe("interrupted")
  expect(
    SessionOutcome.derive([{ ...assistant, content: checks }], false, undefined, [{ ...target, digest: "changed" }], [])
      .state,
  ).toBe("completed_unverified")
  expect(SessionOutcome.derive([{ ...assistant, content: checks }], false, "unrelated-project", [], []).state).toBe(
    "completed_unverified",
  )
})

test("one successful test cannot hide another failing test command", () => {
  const content: SessionMessage.AssistantTool[] = [1, 0].map((exit, index) => ({
    id: String(index),
    type: "tool",
    name: "bash",
    time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: {
        verification: {
          kind: "test",
          command: `test-${index}`,
          exit,
          callID: String(index),
          snapshot: "tree",
        },
      },
    },
  }))
  expect(SessionOutcome.derive([{ ...assistant, content }], false, "tree", [], ["test"]).state).toBe("failed")
})

test("changed shell arguments do not reset failed recovery; inspection does", () => {
  const content: SessionMessage.AssistantTool[] = [1, 2, 3, 4].map((index) => ({
    id: String(index),
    type: "tool",
    name: "bash",
    time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
    state: { status: "completed", input: { command: `variation-${index}` }, content: [], structured: { exit: 1 } },
  }))
  expect(SessionOutcome.recoveryFailures([{ ...assistant, content }])).toBe(4)
  const inspect = {
    ...content[0],
    name: "read",
    state: { status: "completed" as const, input: {}, content: [], structured: {} },
  }
  expect(SessionOutcome.recoveryFailures([{ ...assistant, content: [...content, inspect] }])).toBe(0)
})
