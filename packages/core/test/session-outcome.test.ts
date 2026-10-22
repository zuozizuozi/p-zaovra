import { evidenceScope } from "./fixture/evidence-scope"
import { expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { RelativePath } from "@zaovra-ai/schema/schema"
import path from "node:path"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { SessionOutcome } from "@zaovra-ai/core/session/outcome"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionSchema } from "@zaovra-ai/core/session/schema"
import { ExecutionContext } from "../src/session/execution-context"

const assistant: SessionMessage.Assistant = {
  id: SessionMessage.ID.make("msg_result"),
  type: "assistant",
  agent: "build",
  model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
  content: [],
  finish: "stop",
  metadata: { verificationEnabled: true },
  time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
}

test("K3 planned samples retain new observations and do not count replay twice", () => {
  const contract = { version: 1 as const, samples: ["one", "two"] }
  const user: SessionMessage.User = {
    type: "user",
    id: SessionMessage.ID.make("msg_samples"),
    text: "Measure two planned samples",
    executionContract: contract,
    time: assistant.time,
  }
  const target = { path: path.resolve("measure.cjs"), digest: "same" }
  const context = ExecutionContext.bind(
    ExecutionContext.capture("node measure.cjs", path.dirname(target.path), 5000, false),
    ExecutionContext.approved([user]),
  )
  const run = (callID: string, id: string): SessionMessage.AssistantTool => ({
    type: "tool",
    id: callID,
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: {
        verification: {
          callID,
          kind: "smoke",
          command: "node measure.cjs",
          exit: 0,
          targets: [target],
          executionContext: context,
          sample: { id, planDigest: ExecutionContext.digest(contract) },
          resultDigest: "observed-result",
        },
      },
    },
  })
  const evaluate = (content: SessionMessage.AssistantTool[]) =>
    SessionOutcome.derive([user, { ...assistant, content }], false, undefined, [target], [])
  const one = evaluate([run("first", "one"), run("replay", "one")])
  expect(one.checks).toHaveLength(1)
  expect(one.missing.join(" ")).toContain("sampling: pending approved samples two")
  const two = evaluate([run("first", "one"), run("second", "two")])
  expect(two.checks).toHaveLength(2)
  expect(two.missing.join(" ")).not.toContain("sampling:")
})

test("K3 diagnostic pass is superseded only by fresh formal pass in the same scope", () => {
  const target = { path: path.resolve("product.js"), digest: "same" }
  const run = (id: string, exit: number, diagnostic: boolean): SessionMessage.AssistantTool => ({
    type: "tool",
    id,
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: { verification_replaces: diagnostic ? [] : ["diagnostic"] },
      content: [],
      structured: {
        verification: {
          kind: "test",
          command: diagnostic ? "diagnostic runner" : "formal runner",
          exit,
          callID: id,
          cwd: path.dirname(target.path),
          targets: [target],
          executionContext: {
            entry: { observed: { value: "runner", source: "observed" } },
            cwd: { observed: { value: path.dirname(target.path), source: "observed" } },
            runtime: { observed: { value: null, source: "unknown" } },
            timeout: { observed: { value: "5000", source: "default" } },
            environment: diagnostic
              ? {
                  OMP_NUM_THREADS: {
                    requested: { value: "1", source: "diagnostic-temporary" },
                    observed: { value: "1", source: "observed" },
                  },
                }
              : {},
          },
        },
      },
    },
  })
  const diagnostic = run("diagnostic", 0, true)
  const evaluate = (checks: SessionMessage.AssistantTool[]) =>
    SessionOutcome.derive([{ ...assistant, content: checks }], false, undefined, [target], [])
  expect(evaluate([diagnostic]).missing.join(" ")).toContain("execution context")
  const passed = evaluate([diagnostic, run("formal", 0, false)])
  expect(passed.checks.find((check) => check.callID === "diagnostic")?.supersededBy).toBe("formal")
  expect(passed.missing.join(" ")).not.toContain("execution context")
  const failed = evaluate([diagnostic, run("formal", 1, false)])
  expect(failed.state).toBe("failed")
  expect(failed.checks.find((check) => check.callID === "diagnostic")?.supersededBy).toBeUndefined()
})

test("K1 execution contract rejects diagnostic green, wrong entry and changed relevant environment", () => {
  const condition = (requested: string, observed: string, source: "user" | "diagnostic-temporary" = "user") => ({
    requested: { value: requested, source },
    observed: { value: observed, source: "observed" as const },
  })
  const context = {
    entry: condition("node cli.js", "node cli.js"),
    cwd: condition("/project", "/project"),
    runtime: condition("node 22", "node 22"),
    timeout: condition("30000", "30000"),
    environment: { OMP_NUM_THREADS: condition("8", "1", "diagnostic-temporary") },
  }
  const check = {
    kind: "test" as const,
    command: "node cli.js",
    exit: 0,
    callID: "contract",
    targets: [{ path: "cli.js", digest: "same" }],
    executionContext: context,
  }
  expect(SessionOutcome.checkFreshness(check, check.targets).fresh).toBe(false)
  const agreed = { ...context, environment: { OMP_NUM_THREADS: condition("1", "1") } }
  expect(
    SessionOutcome.checkFreshness({ ...check, executionContext: agreed }, check.targets, undefined, agreed).fresh,
  ).toBe(true)
  expect(
    SessionOutcome.checkFreshness(
      { ...check, executionContext: { ...agreed, entry: condition("node cli.js", "node unit.test.js") } },
      check.targets,
    ).fresh,
  ).toBe(false)
  expect(
    SessionOutcome.checkFreshness({ ...check, executionContext: agreed }, check.targets, undefined, {
      ...agreed,
      environment: { OMP_NUM_THREADS: condition("1", "8") },
    }).fresh,
  ).toBe(false)
  expect(
    SessionOutcome.checkFreshness(
      { ...check, executionContext: agreed },
      [...check.targets, { path: "unrelated.md", digest: "new" }],
      undefined,
      agreed,
    ).fresh,
  ).toBe(true)
  expect(
    SessionOutcome.checkFreshness(
      {
        ...check,
        executionContext: {
          ...agreed,
          runtime: {
            requested: { value: "node 22", source: "user" as const },
            observed: { value: null, source: "unknown" as const },
          },
        },
      },
      check.targets,
    ).fresh,
  ).toBe(false)
})

test("historical checks retain their source without affecting the current verdict and become stale after edits", () => {
  const target = { path: path.resolve("product.js"), digest: "tested" }
  const user = (id: string): SessionMessage.User => ({
    type: "user",
    id: SessionMessage.ID.make(`msg_${id}`),
    text: id,
    time: assistant.time,
  })
  const checked = (exit: number): SessionMessage.Assistant => ({
    ...assistant,
    content: [
      {
        type: "tool",
        id: "check",
        name: "bash",
        time: assistant.time,
        state: {
          status: "completed",
          input: {},
          content: [],
          structured: {
            verification: {
              callID: "check",
              kind: "test",
              command: "node test.js",
              exit,
              targets: [target],
            },
          },
        },
      },
    ],
  })
  const history = [user("original"), checked(0), user("no-checks"), assistant, user("latest"), assistant]
  const previous = SessionOutcome.previousChecks(history, path.dirname(target.path))
  expect(previous).toHaveLength(1)
  expect(previous[0]).toMatchObject({ userMessageID: "msg_original", turn: 1, check: { exit: 0 } })
  expect(SessionOutcome.checkFreshness(previous[0]!.check, [target], undefined).fresh).toBe(true)
  expect(SessionOutcome.checkFreshness(previous[0]!.check, [{ ...target, digest: "edited" }], undefined).fresh).toBe(
    false,
  )
  const outcome = SessionOutcome.derive(SessionOutcome.acceptanceHistory(history), false)
  expect(outcome.checks).toEqual([])
  expect(outcome.state).not.toBe("completed_verified")
  expect(SessionOutcome.previousChecks([user("first"), checked(0)], path.dirname(target.path))).toEqual([])
  expect(
    SessionOutcome.previousChecks(
      [user("first"), checked(0), user("failed"), checked(1), user("latest"), assistant],
      path.dirname(target.path),
    ),
  ).toEqual([])
})

test("same-command fresh target supersets replace failures without hiding different, stale or narrowed checks", () => {
  const source = { path: path.resolve("product.js"), digest: "fixed" }
  const extra = { path: path.resolve("favicon.svg"), digest: "added" }
  const run = (
    id: string,
    exit: number,
    targets = [source],
    command = "node browser-test.cjs",
    kind = "interaction",
  ): SessionMessage.AssistantTool => ({
    id,
    type: "tool",
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: { command, verification_targets: targets.map((t) => t.path) },
      content: [],
      structured: { verification: { callID: id, kind, command, cwd: path.dirname(source.path), exit, targets } },
    },
  })
  const first = run("failed", 1)
  const evaluate = (next: SessionMessage.AssistantTool, current = [source, extra]) =>
    SessionOutcome.derive([{ ...assistant, content: [first, next] }], false, undefined, current, [])
  expect(evaluate(run("fixed", 0, [source, extra])).checks[0].supersededBy).toBe("fixed")
  expect(evaluate(run("fixed", 0, [source, extra])).state).toBe("completed_unverified")
  for (const next of [
    run("failed-again", 1, [source, extra]),
    run("other", 0, [source, extra], "node other.cjs"),
    run("narrow", 0, [extra]),
    run("kind", 0, [source, extra], "node browser-test.cjs", "test"),
  ])
    expect(evaluate(next).state).toBe("failed")
  expect(evaluate(run("stale", 0, [source, extra]), [{ ...source, digest: "changed" }, extra]).state).toBe("failed")
})

test("fresh HTML interaction covers HTML syntax but does not waive explicit syntax requirements", () => {
  const target = { path: path.resolve("index.html"), digest: "html" }
  const tool: SessionMessage.AssistantTool = {
    id: "browser",
    type: "tool",
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: {
        verification: {
          callID: "browser",
          kind: "interaction",
          command: "node browser.cjs",
          exit: 0,
          targets: [target],
        },
      },
    },
  }
  const messages = [{ ...assistant, content: [tool] }]
  expect(SessionOutcome.derive(messages, false, undefined, [target], []).missing).toEqual([])
  expect(SessionOutcome.derive(messages, false, undefined, [target], ["syntax"]).missing).toContain("syntax")
  expect(SessionOutcome.derive(messages, false, undefined, [{ ...target, digest: "changed" }], []).missing).toContain(
    `syntax: ${target.path}`,
  )
})

for (const [label, metadata] of [
  ["policy deny", { phase: "permission", reason: "BlockedError" }],
  ["user correction", { phase: "permission", reason: "CorrectedError" }],
  ["invalid input", { phase: "input" }],
  ["missing workdir", { phase: "input", reason: "missing-directory" }],
  ["no shell", { phase: "execution", reason: "shell-unavailable" }],
  ["environment changed", { phase: "execution", reason: "environment-changed" }],
] as const)
  test(`N2 host ${label} remains not-run with scope and does not count as shell failure`, () => {
    const directory = path.resolve("workspace")
    const tool: SessionMessage.AssistantTool = {
      id: "not-run",
      type: "tool",
      name: "bash",
      time: assistant.time,
      state: {
        status: "error",
        input: { command: "npm run lint", verification: "lint", workdir: "src", verification_targets: ["source.ts"] },
        content: [],
        structured: {},
        error: { type: "unknown", message: "Host refused this invocation", metadata },
      },
    }
    const history = [{ ...assistant, content: [tool] }]
    const result = SessionOutcome.derive(history, false, undefined, [], [], undefined, directory)
    expect(result.state).toBe("completed_unverified")
    expect(result.checks).toMatchObject([
      {
        exit: -1,
        execution: "not-run",
        cwd: path.join(directory, "src"),
        targets: [{ path: path.join(directory, "src/source.ts"), digest: "" }],
      },
    ])
    expect(SessionOutcome.shellRecovery(history).failures).toBe(0)
    expect(
      SessionOutcome.derive(
        [{ ...assistant, metadata: { verificationEnabled: false }, content: [tool] }],
        false,
        undefined,
        [],
        [],
      ).state,
    ).toBe("completed")
  })

test("N2 actual execution failure cannot be relabeled by diagnostic text", () => {
  const tool: SessionMessage.AssistantTool = {
    id: "failed",
    type: "tool",
    name: "bash",
    time: assistant.time,
    state: {
      status: "error",
      input: { command: "npm run lint", verification: "lint" },
      content: [],
      structured: {},
      error: {
        type: "unknown",
        message: "No command was executed is text printed by a failing test",
        metadata: { phase: "execution", reason: "non-zero-exit" },
      },
    },
  }
  const history = [{ ...assistant, content: [tool] }]
  const result = SessionOutcome.derive(history, false, undefined, [], [])
  expect(result.state).toBe("failed")
  expect(result.checks[0].execution).toBeUndefined()
  expect(SessionOutcome.shellRecovery(history).failures).toBe(1)
  const completed: SessionMessage.AssistantTool = {
    ...tool,
    state: {
      status: "completed",
      input: { command: "npm run lint", verification: "lint" },
      content: [{ type: "text", text: "Command not executed" }],
      structured: { exit: 7, verification: { callID: "failed", kind: "lint", command: "npm run lint", exit: 7 } },
    },
  }
  expect(SessionOutcome.derive([{ ...assistant, content: [completed] }], false, undefined, [], []).state).toBe("failed")
})

test("invalid assertion input remains an input rejection rather than a projected verification check", () => {
  const tool: SessionMessage.AssistantTool = {
    id: "bad-path",
    type: "tool",
    name: "bash",
    time: assistant.time,
    provider: { executed: false, resultMetadata: { zaovra: { inputRejected: true } } },
    state: {
      status: "error",
      content: [],
      structured: {},
      input: { command: "npm test", verification: "test", verification_assertions: ["works well"] },
      error: {
        type: "unknown",
        message:
          "Invalid tool input: verification_assertions must contain existing assertion file paths. No command was executed.",
      },
    },
  }
  const messages = [{ ...assistant, content: [tool] }]
  expect(SessionOutcome.derive(messages, false, undefined, [], []).checks).toEqual([])
  expect(SessionOutcome.inputRejections(messages)).toBe(1)
})

test("only host-observed task-created assertions can be corrected after failure", () => {
  const file = path.resolve("workspace/tests/new.test.js")
  const creation = {
    type: "tool",
    id: "create",
    name: "write",
    time: assistant.time,
    state: { status: "completed", input: { path: file }, content: [], structured: { target: file, existed: false } },
  } satisfies SessionMessage.AssistantTool
  const run = (id: string, exit: number, digest: string): SessionMessage.AssistantTool => ({
    type: "tool",
    id,
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: { command: "node test.js" },
      content: [],
      structured: {
        verification: {
          kind: "test",
          command: "node test.js",
          callID: id,
          exit,
          cwd: path.dirname(file),
          targets: [{ path: file, digest }],
          assertions: [{ path: file, digest }],
        },
      },
    },
  })
  const evaluate = (
    prefix: SessionMessage.AssistantTool[],
    current = "fixed",
    suffix: SessionMessage.AssistantTool[] = [],
  ) =>
    SessionOutcome.derive(
      [{ ...assistant, content: [...prefix, run("fail", 1, "broken"), ...suffix, run("pass", 0, "fixed")] }],
      false,
      undefined,
      [{ path: file, digest: current }],
      [],
    )
  expect(evaluate([creation]).state).toBe("completed_verified")
  expect(evaluate([creation], "changed-again").missing.join(" ")).toContain("Failed assertion")
  expect(evaluate([]).missing.join(" ")).toContain("Failed assertion changed")
  expect(
    evaluate([{ ...creation, state: { ...creation.state, structured: { target: file, existed: true } } }]).missing.join(
      " ",
    ),
  ).toContain("Failed assertion changed")
  expect(evaluate([{ ...creation, provider: { executed: true } }]).missing.join(" ")).toContain(
    "Failed assertion changed",
  )
  expect(evaluate([], "fixed", [creation]).missing.join(" ")).toContain("Failed assertion changed")
  const patch = {
    ...creation,
    name: "apply_patch",
    state: { ...creation.state, structured: { applied: [{ type: "add", target: file }] } },
  }
  expect(evaluate([patch]).state).toBe("completed_verified")
  const deleted = { ...patch, state: { ...patch.state, structured: { applied: [{ type: "delete", target: file }] } } }
  expect(evaluate([deleted, patch]).missing.join(" ")).toContain("Failed assertion changed")
  const user: SessionMessage.User = {
    type: "user",
    id: SessionMessage.ID.make("msg_new_task"),
    text: "New independent task",
    time: assistant.time,
  }
  const scoped = SessionOutcome.derive(
    [
      { ...assistant, content: [creation] },
      user,
      { ...assistant, content: [run("fail", 1, "broken"), run("pass", 0, "fixed")] },
    ],
    false,
    undefined,
    [{ path: file, digest: "fixed" }],
    [],
  )
  expect(scoped.missing.join(" ")).toContain("Failed assertion changed")
})

test("review references distinguish replaced, stale, non-check and unknown IDs", () => {
  const targets = [{ path: path.resolve("workspace/src.js"), digest: "current" }]
  const run = (id: string): SessionMessage.AssistantTool => ({
    type: "tool",
    id,
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: { command: "npm test" },
      content: [],
      structured: {
        verification: {
          kind: "test",
          command: "npm test",
          callID: id,
          exit: 0,
          targets,
          requirements: ["Deliver tested code"],
        },
      },
    },
  })
  const messages = [
    {
      ...assistant,
      content: [
        run("old"),
        run("new"),
        { ...run("not-check"), name: "read" },
        { ...run("provider-check"), provider: { executed: true } },
      ],
    },
  ]
  const result = SessionOutcome.derive(messages, false, undefined, targets, [])
  expect(result.checks.map((check) => check.callID)).toEqual(["new"])
  expect(SessionOutcome.checkReferenceProblem("old", messages, result.checks, targets)).toContain(
    "replaced by callID new",
  )
  expect(SessionOutcome.checkReferenceProblem("new", messages, result.checks, targets)).toBeUndefined()
  expect(SessionOutcome.checkReferenceProblem("new", messages, result.checks, [])).toContain("stale check new")
  expect(SessionOutcome.checkReferenceProblem("invented", messages, result.checks, targets)).toBe(
    "unknown check callID invented",
  )
  expect(SessionOutcome.checkReferenceProblem("not-check", messages, result.checks, targets)).toContain(
    "exists but is not",
  )
  expect(SessionOutcome.checkReferenceProblem("provider-check", messages, result.checks, targets)).toContain(
    "exists but is not",
  )
  const user: SessionMessage.User = {
    type: "user",
    id: SessionMessage.ID.make("msg_reference_user"),
    text: "Deliver tested code",
    time: assistant.time,
  }
  const marker: SessionMessage.Synthetic = {
    type: "synthetic",
    id: SessionMessage.ID.make("msg_reference_marker"),
    sessionID: SessionSchema.ID.make("ses_reference"),
    text: "Verification closing review: {}",
    time: assistant.time,
  }
  const evaluate = (id: string) =>
    SessionOutcome.derive(
      [
        user,
        marker,
        {
          ...assistant,
          content: [
            ...messages[0].content,
            {
              type: "tool",
              id: "review",
              name: "verification_review",
              time: assistant.time,
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
                        status: "verified",
                        evidence: [id],
                        coverage: [evidenceScope(id)],
                        conditions: [],
                        note: "checked",
                      },
                    ],
                    unverified: [],
                  },
                },
              },
            },
          ],
        },
      ],
      false,
      undefined,
      targets,
      [],
    )
  expect(evaluate("old").state).toBe("completed_unverified")
  expect(evaluate("old").missing.join(" ")).toContain("replaced by callID new")
  expect(evaluate("new").state).toBe("completed_verified")
})

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
    coverage: [evidenceScope("checked")],
    conditions: [],
    status: "verified" as const,
    note: "Assertions executed",
  }))
  const evaluate = (
    reviewItems = items,
    unverified: string[] = [],
    current = targets,
    userMessageID: string = user.id,
    notes: { text: string; requirements: number[] }[] = [],
    withMarker = true,
  ) =>
    SessionOutcome.derive(
      [
        user,
        ...(withMarker ? [marker] : []),
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
  expect(evaluate(items.slice(0, 1), [], targets, user.id, [], false).state).toBe("completed_unverified")
  expect(
    evaluate(items, [], targets, user.id, [{ text: "Prefer a different style", requirements: [] }], false).state,
  ).toBe("completed_verified")
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
    active = false,
    observationsComplete = true,
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
                      {
                        requirement: 2,
                        evidence,
                        coverage: evidence.map(evidenceScope),
                        conditions: [],
                        status: "verified",
                        note: "Current suite covers every key",
                      },
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
      active,
      undefined,
      current,
      [],
      new Set(),
      undefined,
      [],
      observationsComplete,
    )
  expect(evaluate().state).toBe("completed_verified")
  const pending = evaluate(undefined, undefined, [], undefined, undefined, undefined, true)
  expect(pending.state).toBe("running")
  expect(pending.missing).toEqual(["verification pending: current workspace has not been inspected"])
  const raced = evaluate(undefined, undefined, [], undefined, undefined, undefined, false, false)
  expect(raced.state).toBe("completed_unverified")
  expect(raced.missing).toEqual(pending.missing)
  // A coherent observation still rejects a changed/deleted target; a preview
  // cannot weaken final acceptance or turn an unavailable snapshot into a pass.
  expect(evaluate(undefined, undefined, []).missing.some((item) => item.includes("stale check"))).toBe(true)
  expect(evaluate().missing).toEqual([])
  const observed = SessionOutcome.executions([user, { ...assistant, content: [baseline, edit, check] }])
  expect(SessionOutcome.historyCandidates(observed)).toEqual([
    { callID: "baseline", exit: 1 },
    { callID: "current", exit: 0 },
  ])
  for (const reference of SessionOutcome.historyCandidates(observed))
    expect(SessionOutcome.historicalEvidence(reference, observed)).toBe(true)
  expect(SessionOutcome.historicalEvidenceProblem({ callID: "repair", exit: 0 }, observed)).toContain("only bash")
  expect(SessionOutcome.historicalEvidenceProblem({ callID: "old-turn", exit: 0 }, observed)).toContain(
    "current request",
  )
  expect(SessionOutcome.historicalEvidenceProblem({ callID: "baseline", exit: 0 }, observed)).toContain(
    "observed exit 1",
  )
  expect(
    SessionOutcome.historicalEvidenceProblem({ callID: "baseline", exit: 1, before: "baseline" }, observed),
  ).toContain("timestamps")
  expect(
    SessionOutcome.historicalEvidenceProblem({ callID: "baseline", exit: 1, before: "repair" }, observed),
  ).toBeUndefined()
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
  expect(
    SessionOutcome.historyCandidates(SessionOutcome.executions([{ ...assistant, content: [baseline] }, user])),
  ).toEqual([])
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
  const interactionOnly = SessionOutcome.derive(
    [{ ...assistant, content: [checks[2]!] }],
    false,
    undefined,
    [target],
    [],
  )
  expect(interactionOnly.missing).toEqual([])
  expect(
    SessionOutcome.derive([{ ...assistant, content: [checks[0]!, checks[2]!] }], false, undefined, [target], []),
  ).toMatchObject({ state: "completed_verified", missing: [] })
  expect(
    SessionOutcome.derive([{ ...assistant, content: [checks[0]!, checks[2]!] }], false, undefined, [target], ["build"]),
  ).toMatchObject({ state: "completed_unverified", missing: ["build"] })
  for (const changed of [
    { exit: 1, targets: [target] },
    { exit: 0, targets: [{ ...target, digest: "older" }] },
    { exit: 0, targets: [{ ...target, path: "C:/desktop/other.html" }] },
  ]) {
    const interaction: SessionMessage.AssistantTool = {
      ...checks[2]!,
      state: {
        status: "completed",
        input: {},
        content: [],
        structured: {
          verification: { kind: "interaction", command: "browser-check", callID: "interaction", ...changed },
        },
      },
    }
    const outcome = SessionOutcome.derive(
      [{ ...assistant, content: [checks[0]!, interaction] }],
      false,
      undefined,
      [target, { ...target, path: "C:/desktop/other.html" }],
      [],
    )
    expect(outcome.missing).toContain(`smoke: ${target.path}`)
    expect(outcome.missing).toContain(`interaction: ${target.path}`)
    expect(outcome.state).not.toBe("completed_verified")
  }
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

test("advisory checks preserve warnings separately from execution failures and unknown effects", () => {
  const off = { ...assistant, metadata: { verificationEnabled: false } }
  expect(SessionOutcome.derive([off], false)).toMatchObject({ state: "completed", missing: [] })
  expect(
    SessionOutcome.derive([{ ...off, error: { type: "unknown", message: "connection failed" } }], false).state,
  ).toBe("failed")
  expect(SessionOutcome.derive([{ ...off, time: { created: off.time.created } }], false)).toMatchObject({
    state: "interrupted",
    outcomeUnknown: true,
  })
  const failed: SessionMessage.AssistantTool = {
    type: "tool",
    id: "check",
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: { command: "npm test" },
      content: [],
      structured: {
        verification: { kind: "test", command: "npm test", callID: "check", exit: 1 },
      },
    },
  }
  expect(SessionOutcome.derive([{ ...off, content: [failed] }], false)).toMatchObject({
    state: "completed",
    checks: [{ exit: 1 }],
    missing: ["failed: test (check)"],
  })
  const denied: SessionMessage.AssistantTool = {
    ...failed,
    state: {
      status: "error",
      input: { command: "npm test" },
      content: [],
      structured: {},
      error: { type: "unknown", message: "Permission denied" },
    },
  }
  expect(SessionOutcome.derive([{ ...off, content: [denied] }], false).state).not.toBe("completed_verified")
})

test("default advisory mode retains not-run and stale checks without downgrading completion", () => {
  const target = { path: path.resolve("product.js"), digest: "before" }
  const tool: SessionMessage.AssistantTool = {
    type: "tool",
    id: "browser",
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: { command: "node browser.cjs" },
      content: [],
      structured: {
        verification: {
          kind: "interaction",
          command: "node browser.cjs",
          callID: "browser",
          exit: 1,
          execution: "not-run",
          targets: [target],
        },
      },
    },
  }
  const run = { ...assistant, metadata: undefined, content: [tool] }
  expect(SessionOutcome.derive([run], false, undefined, [target])).toMatchObject({
    state: "completed",
    checks: [{ exit: 1, execution: "not-run" }],
    missing: ["not-run: interaction (browser)"],
  })
  const passed = {
    ...run,
    content: [
      {
        ...tool,
        state: {
          ...tool.state,
          structured: {
            verification: {
              kind: "interaction",
              command: "node browser.cjs",
              callID: "browser",
              exit: 0,
              targets: [target],
            },
          },
        },
      },
    ],
  }
  expect(SessionOutcome.derive([passed], false, undefined, [{ ...target, digest: "after" }])).toMatchObject({
    state: "completed",
    checks: [{ exit: 0 }],
    missing: ["stale: interaction (browser)"],
  })
  expect(SessionOutcome.derive([passed], false, undefined, [target])).toMatchObject({
    state: "completed",
    missing: [],
  })
  expect(SessionOutcome.derive([passed], true, undefined, [])).toMatchObject({ state: "running", missing: [] })
  expect(
    SessionOutcome.derive([{ ...run, metadata: { verificationEnabled: true } }], false, undefined, [target]).state,
  ).toBe("completed_unverified")
})

test("successful reruns inherit explicit replacement chains without weakening their scope", () => {
  const targets = [
    { path: "/src.js", digest: "fixed" },
    { path: "/test.js", digest: "original" },
  ]
  const check = (
    id: string,
    command: string,
    exit: number,
    extra: Record<string, unknown> = {},
    replaces: string[] = [],
  ): SessionMessage.AssistantTool => ({
    id,
    type: "tool",
    name: "bash",
    time: assistant.time,
    state: {
      status: "completed",
      input: { command, verification_replaces: replaces },
      content: [],
      structured: {
        verification: {
          kind: "test",
          callID: id,
          command,
          cwd: "/",
          exit,
          targets,
          assertions: [targets[1]],
          ...extra,
        },
      },
    },
  })
  const a = check("a", "original", 1)
  const b = check("b", "replacement", 0, {}, ["a"])
  const derive = (c: SessionMessage.AssistantTool) =>
    SessionOutcome.derive([{ ...assistant, content: [a, b, c] }], false, undefined, targets, [])
  expect(derive(check("c", "replacement", 0)).checks.find((c) => c.callID === "a")?.supersededBy).toBe("c")
  for (const extra of [
    { assertions: [{ ...targets[1], digest: "changed" }] },
    { targets: [{ ...targets[0], digest: "stale" }, targets[1]] },
  ]) {
    expect(
      derive(check("c", "replacement", 0, extra)).checks.find((c) => c.callID === "a")?.supersededBy,
    ).toBeUndefined()
  }
  expect(derive(check("c", "replacement", 1)).checks.find((c) => c.callID === "a")?.supersededBy).toBeUndefined()
})

test("delivery facts retain snapshot, added and partial files without inferring execution or permission", () => {
  const tool = (
    id: string,
    name: string,
    state: SessionMessage.AssistantTool["state"],
  ): SessionMessage.AssistantTool => ({
    id,
    name,
    type: "tool",
    time: assistant.time,
    state,
  })
  const messages: SessionMessage.Message[] = [
    {
      ...assistant,
      snapshot: { files: [RelativePath.make("shell-created.js")] },
      content: [
        tool("edit-1", "edit", {
          status: "completed",
          input: {},
          content: [],
          structured: { files: [{ file: "source.js", status: "modified" }] },
        }),
        tool("patch-1", "apply_patch", {
          status: "error",
          content: [],
          structured: {},
          input: {},
          error: {
            type: "unknown",
            message: "partial",
            metadata: {
              phase: "mutation",
              reason: "partial-application",
              appliedFiles: JSON.stringify(["added.js"]),
            },
          },
        }),
        tool("denied", "write", {
          status: "error",
          content: [],
          structured: {},
          input: { path: "denied.js" },
          error: { type: "unknown", message: "denied" },
        }),
        tool("pending", "write", { status: "pending", input: '{"path":"pending.js"}' }),
      ],
    },
  ]
  const facts = SessionOutcome.deliveryFacts(messages)
  expect(facts.changes).toEqual([
    { path: "shell-created.js", status: "changed", source: "snapshot" },
    { path: "source.js", status: "modified", source: "tool", callID: "edit-1" },
    { path: "added.js", status: "applied", source: "partial-application", callID: "patch-1" },
  ])
  expect(
    SessionOutcome.deliveryFacts([
      ...messages,
      { type: "user", id: SessionMessage.ID.create(), text: "new unrelated task", time: assistant.time },
    ]).changes,
  ).toEqual([])
})

test("V4 shell identity preserves multiline, escape and heredoc semantics", () => {
  const tool = (command: string, workdir = "."): SessionMessage.AssistantTool => ({
    type: "tool",
    id: command,
    name: "bash",
    time: assistant.time,
    state: { status: "completed", input: { command, workdir }, content: [], structured: { exit: 1 } },
  })
  for (const commands of [
    ["echo first\necho second", "echo first echo second"],
    ["echo first\\\nsecond", "echo first\\ second"],
    ["cat <<EOF\nhello world\nEOF", "cat <<EOF\nhello  world\nEOF"],
    ["echo 'a b'", "echo 'a  b'"],
  ]) {
    const content = [tool(commands[0]), tool(commands[1]), tool(commands[0])]
    expect(SessionOutcome.shellRecovery([{ ...assistant, content }])).toMatchObject({ failures: 3, repeated: 1 })
  }
  const content = Array.from({ length: 3 }, () => tool("cat <<EOF\nhello\nEOF"))
  expect(SessionOutcome.shellRecovery([{ ...assistant, content }])).toMatchObject({ failures: 3, repeated: 3 })
  expect(
    SessionOutcome.shellRecovery([
      { ...assistant, content: Array.from({ length: 10 }, (_, i) => tool(`echo ${i}\nfalse`)) },
    ]),
  ).toMatchObject({ failures: 10, repeated: 1 })
  expect(
    SessionOutcome.shellRecovery([{ ...assistant, content: [tool("false", "one"), tool("false", "two")] }]),
  ).toMatchObject({ failures: 2, repeated: 1 })
})

test("shell recovery resets on real progress without merging different quoted literals or directories", () => {
  const tool = (command: string, exit = 1, workdir = "."): SessionMessage.AssistantTool => ({
    type: "tool",
    id: command,
    name: "bash",
    time: assistant.time,
    state: { status: "completed", input: { command, workdir }, content: [], structured: { exit } },
  })
  const recovery = (content: SessionMessage.AssistantTool[]) =>
    SessionOutcome.shellRecovery([{ ...assistant, content }])
  expect(recovery([tool("inspect  --broken"), tool(" inspect --broken "), tool("inspect --broken")])).toMatchObject({
    failures: 3,
    repeated: 3,
  })
  expect(recovery([tool("inspect 'a b'"), tool("inspect 'a  b'")])).toMatchObject({ failures: 2, repeated: 1 })
  expect(recovery([tool("inspect", 1, "one"), tool("inspect", 1, "two")])).toMatchObject({ failures: 2, repeated: 1 })
  expect(recovery([tool("bad"), tool("inspect", 0), tool("bad")])).toMatchObject({ failures: 1, repeated: 1 })
  expect(
    recovery([
      tool("bad"),
      { ...tool("read"), name: "read", state: { status: "completed", input: {}, content: [], structured: {} } },
      tool("bad"),
    ]),
  ).toMatchObject({ failures: 1, repeated: 1 })
})

function evidence302(
  id: string,
  exit: number,
  cwd: string,
  targets: string[],
  sequence: number,
  observed = id,
): SessionMessage.AssistantTool {
  return {
    type: "tool",
    id: observed,
    name: "bash_job",
    time: { created: DateTime.makeUnsafe(100), ran: DateTime.makeUnsafe(100), completed: DateTime.makeUnsafe(101) },
    state: {
      status: "completed",
      input: { job_id: `job-${id}`, action: "wait" },
      content: [],
      structured: {
        verification: {
          callID: id,
          kind: "test",
          command: "node check.cjs",
          exit,
          cwd,
          targets: targets.map((path) => ({ path, digest: "same" })),
          assertions: targets.map((path) => ({ path, digest: "same" })),
          executionRecord: {
            scope: { cwd, command: "node check.cjs", targets, kind: "test" },
            id,
            originCallID: id,
            jobID: `job-${id}`,
            sequence,
            started: sequence * 10,
            completed: sequence * 10 + 1,
            exit,
          },
        },
      },
    },
  }
}
for (const different of ["cwd", "target"])
  test(`302 O2 separate ${different} failures survive managed success`, () => {
    const a = path.resolve("a"),
      b = different === "cwd" ? path.resolve("b") : a
    const targets = [path.join(a, "one.cjs"), path.join(b, "two.cjs")]
    const result = SessionOutcome.derive(
      [{ ...assistant, content: [evidence302("a", 1, a, [targets[0]], 1), evidence302("b", 0, b, [targets[1]], 2)] }],
      false,
      undefined,
      targets.map((path) => ({ path, digest: "same" })),
      [],
    )
    expect(result.checks).toHaveLength(2)
    expect(result.state).toBe("failed")
  })
test("302 O2 target ordering is scope-independent and a new run repairs the same scope", () => {
  const cwd = path.resolve("a"),
    targets = [path.join(cwd, "one.cjs"), path.join(cwd, "two.cjs")]
  const result = SessionOutcome.derive(
    [
      {
        ...assistant,
        content: [evidence302("a", 1, cwd, targets, 1), evidence302("b", 0, cwd, [...targets].reverse(), 2)],
      },
    ],
    false,
    undefined,
    targets.map((path) => ({ path, digest: "same" })),
    [],
  )
  expect(result.checks.filter((check) => !check.supersededBy)).toHaveLength(1)
  expect(result.missing).toEqual([])
  expect(result.state).toBe("completed_verified")
})
for (const order of [
  ["a", "b", "a"],
  ["b", "a", "a"],
  ["a", "b", "a", "a"],
])
  test(`302 O3 old success observations never erase new assertion failure ${order}`, () => {
    const cwd = path.resolve("a"),
      target = path.join(cwd, "one.cjs")
    const content = order.map((id, index) =>
      evidence302(id, id === "a" ? 0 : 1, cwd, [target], id === "a" ? 1 : 2, `observation-${index}`),
    )
    const result = SessionOutcome.derive(
      [{ ...assistant, content }],
      false,
      undefined,
      [{ path: target, digest: "same" }],
      [],
    )
    expect(result.state).toBe("failed")
    expect(result.checks.filter((check) => !check.supersededBy).some((check) => check.exit === 1)).toBe(true)
    const repaired = SessionOutcome.derive(
      [{ ...assistant, content: [...content, evidence302("c", 0, cwd, [target], 3)] }],
      false,
      undefined,
      [{ path: target, digest: "same" }],
      [],
    )
    expect(repaired.state).toBe("completed_verified")
  })
for (const started of [15, 25])
  test(`302 O4 uses execution completion instead of observation order ${started}`, () => {
    const edit: SessionMessage.AssistantTool = {
      type: "tool",
      id: "edit",
      name: "edit",
      time: {
        created: DateTime.makeUnsafe(started),
        ran: DateTime.makeUnsafe(started),
        completed: DateTime.makeUnsafe(started + 1),
      },
      state: { status: "completed", input: {}, content: [], structured: {} },
    }
    const red = evidence302("red", 1, path.resolve("a"), [], 2, "late-observation")
    const history = SessionOutcome.executions([{ ...assistant, content: [edit, red] }])
    expect(SessionOutcome.historyCandidates(history)).toContainEqual({ callID: "red", exit: 1 })
    expect(SessionOutcome.historicalEvidence({ callID: "red", exit: 1, before: "edit" }, history)).toBe(started > 21)
  })

test("302 O3 suite categories survive idempotent observations without summary masking", () => {
  const cwd = path.resolve("suite"),
    target = path.join(cwd, "test.cjs")
  const part = evidence302("suite", 0, cwd, [target], 1)
  if (part.state.status !== "completed") throw Error("fixture")
  const base = part.state.structured.verification as Record<string, unknown>
  const suite = {
    ...part,
    state: {
      ...part.state,
      structured: {
        verification: base,
        verifications: [
          { ...base, kind: "test", exit: 1 },
          { ...base, kind: "lint", exit: 0 },
        ],
      },
    },
  }
  const result = SessionOutcome.derive(
    [{ ...assistant, content: [suite, suite] }],
    false,
    undefined,
    [{ path: target, digest: "same" }],
    [],
  )
  expect(result.checks).toHaveLength(2)
  expect(result.state).toBe("failed")
})
test("302 O4 durable shell completion survives serialization without any observation", () => {
  const record = {
    scope: { cwd: path.resolve("a"), command: "node check.cjs", targets: [] },
    id: "red-id",
    originCallID: "red",
    jobID: "job-red",
    sequence: 1,
    started: 10,
    completed: 20,
    exit: 1,
  }
  const shell: SessionMessage.Shell = {
    id: SessionMessage.ID.make("msg_shell"),
    type: "shell",
    callID: "job-red",
    command: "node check.cjs",
    output: "failed",
    executionRecord: record,
    time: { created: DateTime.makeUnsafe(10), completed: DateTime.makeUnsafe(50) },
  }
  const edit: SessionMessage.AssistantTool = {
    type: "tool",
    id: "edit",
    name: "edit",
    time: { created: DateTime.makeUnsafe(30), ran: DateTime.makeUnsafe(30), completed: DateTime.makeUnsafe(31) },
    state: { status: "completed", input: {}, content: [], structured: {} },
  }
  const restored = Schema.decodeUnknownSync(SessionMessage.Message)(
    JSON.parse(JSON.stringify(Schema.encodeSync(SessionMessage.Message)(shell))),
  )
  expect(
    SessionOutcome.historicalEvidence(
      { callID: "red", exit: 1, before: "edit" },
      SessionOutcome.executions([restored, { ...assistant, content: [edit] }]),
    ),
  ).toBe(true)
  expect(
    SessionOutcome.historicalEvidence(
      { callID: "red", exit: 1, before: "edit" },
      SessionOutcome.executions([
        { ...shell, executionRecord: { ...record, completed: undefined } },
        { ...assistant, content: [edit] },
      ]),
    ),
  ).toBe(false)
})

test("302 O4 observation call IDs resolve the immutable execution without changing chronology", () => {
  const red = evidence302("red", 1, path.resolve("a"), [], 2, "observation-one")
  const repeat = evidence302("red", 1, path.resolve("a"), [], 2, "observation-two")
  const edit: SessionMessage.AssistantTool = {
    type: "tool",
    id: "edit",
    name: "edit",
    time: { created: DateTime.makeUnsafe(30), ran: DateTime.makeUnsafe(30), completed: DateTime.makeUnsafe(31) },
    state: { status: "completed", input: {}, content: [], structured: {} },
  }
  const observed = SessionOutcome.executions([{ ...assistant, content: [edit, red, repeat] }])
  expect(SessionOutcome.historyCandidates(observed)).toEqual([{ callID: "red", exit: 1 }])
  expect(SessionOutcome.historicalEvidence({ callID: "observation-one", exit: 1, before: "edit" }, observed)).toBe(true)
  expect(SessionOutcome.historicalEvidence({ callID: "observation-two", exit: 1, before: "edit" }, observed)).toBe(true)
})

test("304 new identified suite replaces coverage once across durable and repeated observations", () => {
  const cwd = path.resolve("suite304")
  const target = { path: path.join(cwd, "game.html"), digest: "same" }
  const suite = (
    id: string,
    sequence: number,
    kinds: string[],
    directory = cwd,
    sample?: string,
    file = target.path,
  ) => {
    const part = evidence302(id, 0, directory, [file], sequence)
    if (part.state.status !== "completed") throw Error("fixture")
    const base = part.state.structured.verification as Record<string, unknown>
    return {
      ...part,
      state: {
        ...part.state,
        structured: {
          verifications: kinds.map((kind) => ({
            ...base,
            kind,
            ...(sample ? { sample: { id: sample, planDigest: "plan" } } : {}),
          })),
        },
      },
    }
  }
  const full = suite("full304", 1, ["syntax", "smoke", "interaction"])
  const reduced = suite("reduced304", 2, ["syntax", "smoke"])
  const restored = suite("restored304", 3, ["syntax", "smoke", "interaction"])
  const derive = (content: SessionMessage.AssistantTool[], shells: SessionMessage.Shell[] = []) =>
    SessionOutcome.derive([{ ...assistant, content }, ...shells], false, undefined, [target], [])
  expect(derive([full]).state).toBe("completed_verified")
  expect(derive([full, reduced])).toMatchObject({
    state: "completed_unverified",
    missing: ["interaction: " + target.path],
  })
  expect(derive([full, reduced, full, { ...full, id: "get-full" }]).state).toBe("completed_unverified")
  const checks = SessionOutcome.toolChecks(reduced)
  const shell: SessionMessage.Shell = {
    id: SessionMessage.ID.make("msg_suite304"),
    type: "shell",
    callID: "job-reduced304",
    command: "node check.cjs",
    output: "done",
    checks,
    executionRecord: checks[0]!.executionRecord,
    time: { created: DateTime.makeUnsafe(20), completed: DateTime.makeUnsafe(21) },
  }
  const persisted = Schema.decodeUnknownSync(SessionMessage.Shell)(Schema.encodeSync(SessionMessage.Shell)(shell))
  expect(derive([full, reduced, reduced], [persisted, persisted]).state).toBe("completed_unverified")
  expect(derive([full, reduced, restored, full, reduced], [shell]).state).toBe("completed_verified")
  expect(derive([full, suite("other-cwd", 2, ["syntax", "smoke"], path.resolve("elsewhere"))]).state).toBe(
    "completed_verified",
  )
  expect(
    derive([
      full,
      suite("other-target", 2, ["syntax", "smoke"], cwd, undefined, path.join(cwd, "other.html")),
    ]).checks.some((check) => check.kind === "interaction" && check.callID === "full304"),
  ).toBe(true)
  expect(derive([full, suite("other-sample", 2, ["syntax", "smoke"], cwd, "mobile")]).state).toBe("completed_verified")
})

test("S1 runtime and verification are independent and old finishes retain interpretation", () => {
  expect(SessionOutcome.derive([assistant], false)).toMatchObject({ runtime: "completed", verification: "unverified" })
  expect(
    SessionOutcome.derive(
      [{ ...assistant, finish: "stopped", termination: { category: "budget", message: "limit" } }],
      false,
    ),
  ).toMatchObject({
    state: "stopped",
    runtime: "stopped",
    verification: "unverified",
    termination: { category: "budget" },
  })
  expect(SessionOutcome.derive([{ ...assistant, finish: "max-steps" }], false).state).toBe("failed")
  expect(SessionOutcome.derive([{ ...assistant, finish: "interrupted" }], false).runtime).toBe("interrupted")
})
