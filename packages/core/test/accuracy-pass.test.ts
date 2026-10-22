import { expect, test } from "bun:test"
import { DateTime } from "effect"
import { SessionOutcome } from "@zaovra-ai/core/session/outcome"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionSchema } from "@zaovra-ai/core/session/schema"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { AccuracyGuidance } from "@zaovra-ai/core/system-context/accuracy"

const scope: NonNullable<Parameters<typeof SessionOutcome.reviewProblems>[0]["coverage"]>[number] = {
  callID: "check",
  dimensions: ["content", "directories", "types"],
  inputScale: "100 inputs including empty directories",
  generalization: "non-example inputs asserted by actual entrypoint",
  performance: "not requested",
  dependencies: "real" as const,
  artifacts: "fresh" as const,
  result: "passed" as const,
}
const item: Parameters<typeof SessionOutcome.reviewProblems>[0] = {
  requirement: 1,
  evidence: ["check"],
  coverage: [scope],
  conditions: [{ text: "output prefix specified by user", status: "met" as const }],
  status: "verified" as const,
  note: "Observed",
}

test("331 scope distinguishes mock interface, real acceptance and artifact freshness", () => {
  expect(SessionOutcome.reviewProblems(item)).toEqual([])
  expect(SessionOutcome.reviewProblems({ ...item, coverage: undefined }).join(" ")).toContain("needs exactly one")
  expect(SessionOutcome.reviewProblems({ ...item, coverage: [{ ...scope, inputScale: "" }] }).join(" ")).toContain(
    "incomplete coverage",
  )
  expect(
    SessionOutcome.reviewProblems({ ...item, coverage: [{ ...scope, dependencies: "mock" }] }).join(" "),
  ).toContain("mock proves only")
  expect(
    SessionOutcome.reviewProblems({
      ...item,
      coverage: [{ ...scope, dependencies: "mock", dimensions: ["interface"] }],
    }).join(" "),
  ).toContain("mock proves only")
  expect(
    SessionOutcome.reviewProblems({
      ...item,
      acceptance: "interface",
      coverage: [{ ...scope, dependencies: "mock", dimensions: ["interface"] }],
    }),
  ).toEqual([])
  expect(SessionOutcome.reviewProblems({ ...item, coverage: [{ ...scope, artifacts: "stale" }] }).join(" ")).toContain(
    "old artifact",
  )
  expect(SessionOutcome.reviewProblems({ ...item, coverage: [{ ...scope, result: "failed" }] }).join(" ")).toContain(
    "semantic result is failed",
  )
  expect(
    SessionOutcome.reviewProblems({ ...item, conditions: [{ text: "prefix", status: "unmet" }] }).join(" "),
  ).toContain("condition unmet")
  expect(SessionOutcome.reviewProblems({ ...item, conditions: undefined }).join(" ")).toContain("declare the status")
  expect(
    SessionOutcome.reviewProblems({
      ...item,
      status: "unverified",
      note: "Permission denied; unable to check real dependency",
    }),
  ).toEqual([])
  expect(SessionOutcome.reviewProblems({ ...item, status: "unverified", note: "" }).join(" ")).toContain(
    "explain the resource",
  )
  expect(
    SessionOutcome.reviewProblems({ ...item, kind: "process", conditions: [{ text: "prefix", status: "unmet" }] }).join(
      " ",
    ),
  ).toContain("condition unmet")
})

test("331 exit-zero semantic failures and stale/mock results cannot yield verified delivery", () => {
  const time = { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) }
  const user: SessionMessage.User = {
    id: SessionMessage.ID.make("msg_accuracy"),
    type: "user",
    text: "Restore all files and directories",
    time,
  }
  const assistant: SessionMessage.Assistant = {
    id: SessionMessage.ID.make("msg_accuracy_result"),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    finish: "stop",
    metadata: { verificationEnabled: true },
    time,
    content: [],
  }
  const target = { path: "source.js", digest: "same" }
  const check: SessionMessage.AssistantTool = {
    id: "check",
    type: "tool",
    name: "bash",
    time,
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: {
        verification: {
          callID: "check",
          kind: "test",
          command: "node verify.js",
          exit: 0,
          targets: [target],
          requirements: [user.text],
        },
      },
    },
  }
  const evaluate = (coverage: typeof scope) =>
    SessionOutcome.derive(
      [
        user,
        {
          type: "synthetic",
          id: SessionMessage.ID.make("msg_accuracy_marker"),
          sessionID: SessionSchema.ID.make("ses_accuracy"),
          text: "Verification closing review:",
          time,
        },
        {
          ...assistant,
          content: [
            check,
            {
              id: "review",
              type: "tool",
              name: "verification_review",
              time,
              state: {
                status: "completed",
                input: {},
                content: [],
                structured: {
                  review: {
                    userMessageID: user.id,
                    items: [{ ...item, coverage: [coverage] }],
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
      [target],
      [],
    )
  expect(evaluate(scope).state).toBe("completed_verified")
  for (const coverage of [
    { ...scope, result: "failed" as const },
    { ...scope, artifacts: "stale" as const },
    { ...scope, dependencies: "mock" as const },
  ]) {
    expect(evaluate(coverage).state).toBe("completed_unverified")
  }
})

test("331 preservation and sanity guidance does not authorize invented data", () => {
  expect(AccuracyGuidance.general).toContain("BEFORE investigating")
  expect(AccuracyGuidance.general).toContain("sidecar files and untracked inputs")
  expect(AccuracyGuidance.general).toContain("SQLite connection can checkpoint or consume WAL")
  expect(AccuracyGuidance.general).toContain("recheck units, input selection and conversions")
  expect(AccuracyGuidance.general).toContain("not permission to change the conclusion")
  expect(AccuracyGuidance.general).toContain("Never fabricate or fill in data")
})

test("331 delivery checkpoint uses remaining wall-clock time and never invents an unlimited budget", () => {
  expect(AccuracyGuidance.checkpoint({ elapsed: 49, limit: 100 })).toBeUndefined()
  expect(AccuracyGuidance.checkpoint({ elapsed: 50, limit: 100 })).toContain("50ms remain")
  expect(AccuracyGuidance.checkpoint({ elapsed: 99, limit: 100 })).toContain("basic requested acceptance")
  expect(AccuracyGuidance.checkpoint({ elapsed: 100, limit: 100 })).toBeUndefined()
  expect(AccuracyGuidance.checkpoint({ elapsed: 100 })).toBeUndefined()
  expect(AccuracyGuidance.checkpoint({ elapsed: NaN, limit: 100 })).toBeUndefined()
})

test("331 an exit-zero semantic failure or unmet condition needs a later relevant check, never just new review prose", () => {
  const time = { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) }
  const user: SessionMessage.User = {
    id: SessionMessage.ID.make("msg_continuity"),
    type: "user",
    text: "Preserve the required output prefix",
    time,
  }
  const target = { path: "source.js", digest: "same" }
  const check = (callID: string, command = "node verify.js"): SessionMessage.AssistantTool => ({
    id: callID,
    type: "tool",
    name: "bash",
    time,
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: { verification: { callID, kind: "test", command, exit: 0, targets: [target] } },
    },
  })
  const review = { userMessageID: user.id, items: [item], unverified: [] }
  const failure: SessionMessage.AssistantTool = {
    id: "review-failure",
    type: "tool",
    name: "verification_review",
    time,
    state: {
      status: "completed",
      input: {},
      content: [],
      structured: {
        review: {
          ...review,
          items: [
            {
              ...item,
              status: "unverified",
              coverage: [{ ...scope, result: "failed" }],
              conditions: [{ text: "prefix", status: "unmet" }],
            },
          ],
        },
      },
    },
  }
  const history = (rerun?: SessionMessage.AssistantTool): SessionMessage.Message[] => [
    user,
    {
      id: SessionMessage.ID.make("msg_continuity_assistant"),
      type: "assistant",
      agent: "build",
      model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
      finish: "stop",
      time,
      content: [check("check"), failure, ...(rerun ? [rerun] : [])],
    },
  ]
  const current = {
    ...review,
    items: [
      {
        ...item,
        evidence: ["rerun"],
        coverage: [{ ...scope, callID: "rerun" }],
        conditions: [{ text: "prefix", status: "met" as const }],
      },
    ],
  }
  expect(
    SessionOutcome.reviewContinuityProblems(
      history(),
      review,
      [SessionOutcome.toolChecks(check("check"))[0]],
      [target],
    ).join(" "),
  ).toContain("rewriting the review")
  expect(
    SessionOutcome.reviewContinuityProblems(
      history(check("rerun", "node unrelated.js")),
      current,
      [SessionOutcome.toolChecks(check("rerun", "node unrelated.js"))[0]],
      [target],
    ).join(" "),
  ).toContain("semantic failure")
  expect(
    SessionOutcome.reviewContinuityProblems(
      history(check("rerun")),
      current,
      [SessionOutcome.toolChecks(check("rerun"))[0]],
      [target],
    ),
  ).toEqual([])
  expect(
    SessionOutcome.reviewContinuityProblems(
      history(check("rerun")),
      { ...current, items: [{ ...current.items[0], conditions: [] }] },
      [SessionOutcome.toolChecks(check("rerun"))[0]],
      [target],
    ).join(" "),
  ).toContain("unmet condition")
})
