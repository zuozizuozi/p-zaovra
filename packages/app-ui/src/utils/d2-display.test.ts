import { describe, expect, test } from "bun:test"
import { usageDisplay } from "./usage-display"
import { artifactLines } from "./artifact-lines"
import { commandVerification, workVerification } from "./verification-label"

describe("D2 evidence and usage display", () => {
  test("disjoint accounting: output includes reasoning once; missing usage has no hit rate", () => {
    const total = {
      input: 30,
      cacheRead: 60,
      cacheWrite: 10,
      output: 8,
      reasoning: 2,
      total: 110,
      calls: 1,
      unreported: 0,
    }
    expect(usageDisplay(total)).toEqual({ output: 10, hitRate: 0.6, unknown: false })
    expect(usageDisplay({ ...total, unreported: 1 }).hitRate).toBeUndefined()
    expect(usageDisplay({ ...total, total: 0, unreported: 1 }).unknown).toBe(true)
  })
  test("text line counts exclude trailing terminator and never count binary/base64", () => {
    expect(artifactLines({ type: "text", content: "a\r\nb\r\n" })).toBe(2)
    expect(artifactLines({ type: "text", content: "" })).toBe(0)
    expect(artifactLines({ type: "text", content: "\n" })).toBe(1)
    expect(artifactLines({ type: "text", content: "png", encoding: "base64" })).toBeUndefined()
    expect(artifactLines({ type: "binary", content: "bytes" })).toBeUndefined()
  })
  test("unfinished and obsolete commands never receive a current pass label", () => {
    expect(commandVerification({ exit: 0 })).toBe("commandPassed")
    expect(commandVerification({ exit: 1 })).toBe("commandFailed")
    expect(commandVerification({ exit: 0, execution: "timeout" })).toBe("missingEvidence")
    expect(commandVerification({ exit: 0, eligiblePass: false })).toBe("missingEvidence")
    expect(commandVerification({ exit: 0, supersededBy: "later" })).toBe("missingEvidence")
  })
  test("model prose and untrusted payloads cannot masquerade as host command evidence", () => {
    expect(workVerification({ kind: "review", producer: "work-reviewer/1", payload: { verdict: "pass" } })).toBe(
      "modelReview",
    )
    expect(
      workVerification({ kind: "command", producer: "developer", payload: { type: "command", exitCode: 0 } }, "pass"),
    ).toBe("missingEvidence")
    expect(
      workVerification(
        { kind: "command", producer: "work-verifier/command", payload: { type: "command", exitCode: 2 } },
        "pass",
      ),
    ).toBe("commandPassed")
    expect(
      workVerification(
        { kind: "command", producer: "work-verifier/command", payload: { type: "command", exitCode: 2 } },
        "fail",
      ),
    ).toBe("commandFailed")
    expect(
      workVerification({
        kind: "command",
        producer: "session-host/1",
        payload: { checks: [{ exit: 0, eligiblePass: false }] },
      }),
    ).toBe("missingEvidence")
    expect(
      workVerification({
        kind: "command",
        producer: "session-host/1",
        payload: { checks: [{ exit: 0, eligiblePass: true }], missing: [] },
      }),
    ).toBe("commandPassed")
  })
})
