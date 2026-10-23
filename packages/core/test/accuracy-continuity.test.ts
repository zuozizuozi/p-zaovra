import { expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import path from "node:path"
import { SessionOutcome } from "@zaovra-ai/core/session/outcome"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { ExecutionContext } from "@zaovra-ai/core/session/execution-context"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { evidenceScope } from "./fixture/evidence-scope"

const time = { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) }
const user: SessionMessage.User = {
  id: SessionMessage.ID.make("msg_accuracy13"),
  type: "user",
  text: "Preserve the output prefix.",
  time,
}
const target = { path: path.resolve("source.js"), digest: "current" }
const assistant = (content: SessionMessage.AssistantTool[]): SessionMessage.Assistant => ({
  id: SessionMessage.ID.make("msg_accuracy13_assistant"),
  type: "assistant",
  agent: "build",
  model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
  finish: "stop",
  metadata: { verificationEnabled: true },
  time,
  content,
})
const check = (
  callID: string,
  options: Partial<ReturnType<typeof SessionOutcome.toolChecks>[number]> = {},
  replaces: string[] = [],
): SessionMessage.AssistantTool => ({
  id: callID,
  type: "tool",
  name: "bash",
  time,
  state: {
    status: "completed",
    input: { verification_replaces: replaces },
    content: [],
    structured: {
      verification: {
        callID,
        kind: "test",
        command: "node verify.js",
        cwd: path.dirname(target.path),
        exit: 0,
        targets: [target],
        requirements: [user.text],
        ...options,
      },
    },
  },
})
const item = (ids: string[], failed = false) => ({
  requirement: 1,
  evidence: ids,
  coverage: ids.map((id) => ({ ...evidenceScope(id), result: failed ? ("failed" as const) : ("passed" as const) })),
  conditions: [{ text: "prefix", status: failed ? ("unmet" as const) : ("met" as const) }],
  status: failed ? ("unverified" as const) : ("verified" as const),
  note: "Observed output prefix",
})
const review = (items = [item(["first"])], userMessageID = user.id): SessionMessage.AssistantTool => ({
  id: "review-" + userMessageID,
  type: "tool",
  name: "verification_review",
  time,
  state: {
    status: "completed",
    input: {},
    content: [],
    structured: { review: { userMessageID, items, unverified: [] } },
  },
})
const derive = (messages: SessionMessage.Message[]) => SessionOutcome.derive(messages, false, undefined, [target], [])
const failure = assistant([check("first"), review([item(["first"], true)])])

for (const text of ["继续", SessionOutcome.RECOVERY_PROMPT, "追加要求：Check formatting.", user.text])
  test(`13 continuity retains the stable clause across ${text.slice(0, 16)}`, () => {
    const next = { ...user, id: SessionMessage.ID.make("msg_accuracy13_continue"), text }
    const clauses = SessionOutcome.requested([user, failure, next]).entries
    const latest = review(
      clauses.map((entry) => ({ ...item(["first"]), requirement: entry.id })),
      next.id,
    )
    const messages = [user, failure, next, assistant([latest])]
    const result = derive(messages)
    expect(result.state).toBe("completed_unverified")
    expect(result.missing.join(" ")).toContain("semantic failure (first)")
    expect(result.missing.join(" ")).toContain("unmet condition prefix")
    expect(
      SessionOutcome.derive(messages, false, undefined, [target], [], new Set(), undefined, [], true, false).state,
    ).toBe("completed")
    const restored = messages.map((message) =>
      Schema.decodeUnknownSync(SessionMessage.Message)(
        JSON.parse(JSON.stringify(Schema.encodeSync(SessionMessage.Message)(message))),
      ),
    )
    expect(derive(restored).missing).toEqual(result.missing)
  })

test("13 a real rerun after continuation closes the original semantic failure", () => {
  const next = { ...user, id: SessionMessage.ID.make("msg_accuracy13_continue"), text: "继续" }
  expect(derive([user, failure, next, assistant([check("rerun"), review([item(["rerun"])], next.id)])]).state).toBe(
    "completed_verified",
  )
})

test("13 new tasks and exact user withdrawals do not inherit unrelated failures", () => {
  const next = { ...user, id: SessionMessage.ID.make("msg_accuracy13_new"), text: "Verify the other component." }
  expect(derive([user, failure, next, assistant([check("new"), review([item(["new"])], next.id)])]).state).toBe(
    "completed_verified",
  )
  const withdrawal = { ...next, text: `修改要求：取消要求“${user.text}”` }
  expect(SessionOutcome.requested([user, failure, withdrawal]).entries[0].withdrawnBy).toBe(next.id)
  expect(derive([user, failure, withdrawal, assistant([review([], next.id)])]).missing.join(" ")).not.toContain(
    "semantic failure",
  )
})

test("13 same-turn rewriting never clears failure", () => {
  expect(derive([user, failure, assistant([review()])]).missing.join(" ")).toContain("semantic failure")
})

for (const candidate of ["two", "wrong-plan", "stale", "unrelated", "one"])
  test(`13 sampled semantic failure needs the same sample and plan: ${candidate}`, () => {
    const contract = { version: 1 as const, samples: ["one", "two"] }
    const sample = (id: string) => ({ id, planDigest: ExecutionContext.digest(contract) })
    const source = { ...user, executionContract: contract }
    const options = { sample: sample("one") }
    const context = ExecutionContext.bind(
      ExecutionContext.capture("node verify.js", path.dirname(target.path), 5000, false),
      ExecutionContext.approved([source]),
    )
    const first = check("first", { ...options, executionContext: context })
    const second = check("second", { sample: sample("two"), executionContext: context })
    const rerun = check("rerun", {
      executionContext: context,
      sample:
        candidate === "two"
          ? sample("two")
          : candidate === "wrong-plan"
            ? { id: "one", planDigest: "different" }
            : sample("one"),
      ...(candidate === "stale" ? { targets: [{ ...target, digest: "old" }] } : {}),
      ...(candidate === "unrelated" ? { command: "node unrelated.js" } : {}),
    })
    const result = derive([
      source,
      assistant([first, review([item(["first"], true)]), second, rerun, review([item(["second", "rerun"])])]),
    ])
    expect(result.state).toBe(candidate === "one" ? "completed_verified" : "completed_unverified")
    if (candidate !== "one") expect(result.missing.join(" ")).toContain("semantic failure")
  })

for (const evidence of ["related", "unrelated", "mock"])
  test(`13 first check closes an untested condition only with relevant real evidence: ${evidence}`, () => {
    const old = { ...item([], true), coverage: [] }
    const current = item(["first"])
    if (evidence === "mock") current.coverage = [{ ...current.coverage[0], dependencies: "mock" }]
    const result = derive([
      user,
      assistant([
        review([old]),
        check("first", { requirements: evidence === "unrelated" ? ["Another requirement"] : [user.text] }),
        review([current]),
      ]),
    ])
    expect(result.state).toBe(evidence === "related" ? "completed_verified" : "completed_unverified")
    if (evidence !== "related") expect(result.missing.join(" ")).toContain("unmet condition")
  })

for (const exit of [0, 1])
  test(`13 formal replacement chain survives a later exact rerun after original exit ${exit}`, () => {
    const command = "node fixed-verifier.js"
    const result = derive([
      user,
      assistant([
        check("first", { exit }),
        review([item(["first"], true)]),
        check("replacement", { command }, ["first"]),
        check("rerun", { command }),
        review([item(["rerun"])]),
      ]),
    ])
    expect(result.state).toBe("completed_verified")
  })

for (const exit of [0, 1])
  for (const replacement of ["safe", "implicit", "reduced", "assertion", "sample"])
    test(`13 formal replacement after exit ${exit} respects ${replacement} boundaries`, () => {
      const assertion = { path: path.resolve("verify.test.js"), digest: "protected" }
      const before = check("first", { exit, targets: [target, assertion], assertions: [assertion] })
      const after = check(
        "replacement",
        {
          command: "node fixed-verifier.js",
          targets: replacement === "reduced" ? [assertion] : [target, assertion],
          assertions: [{ ...assertion, digest: replacement === "assertion" ? "changed" : assertion.digest }],
          ...(replacement === "sample" ? { sample: { id: "other", planDigest: "other" } } : {}),
        },
        replacement === "implicit" ? [] : ["first"],
      )
      const result = SessionOutcome.derive(
        [user, assistant([before, review([item(["first"], true)]), after, review([item(["replacement"])])])],
        false,
        undefined,
        [target, assertion],
        [],
      )
      expect(result.state).toBe(
        replacement === "safe" ? "completed_verified" : exit === 1 ? "failed" : "completed_unverified",
      )
      if (replacement !== "safe") expect(result.missing.join(" ")).toContain("semantic failure")
      if (exit === 1 && replacement === "safe")
        expect(result.checks.find((check) => check.callID === "first")?.supersededBy).toBe("replacement")
    })
