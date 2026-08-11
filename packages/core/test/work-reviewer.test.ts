import { describe, expect, test } from "bun:test"
import { WorkReviewer } from "@zaovra-ai/core/work/reviewer"
import { Effect, Exit } from "effect"

describe("WorkReviewer", () => {
  test("parses exact and fenced structured criterion verdicts", async () => {
    const json = JSON.stringify({
      criteria: [
        {
          criterionID: "criterion_review",
          verdict: "fail",
          findings: [{ message: "Missing boundary test", severity: "error", location: "src/index.ts" }],
          allowsRepair: true,
        },
      ],
    })

    expect(await Effect.runPromise(WorkReviewer.parse(json))).toMatchObject({
      criteria: [{ criterionID: "criterion_review", verdict: "fail" }],
    })
    expect(await Effect.runPromise(WorkReviewer.parse(`\`\`\`json\n${json}\n\`\`\``))).toMatchObject({
      criteria: [{ criterionID: "criterion_review", verdict: "fail" }],
    })
  })

  test("rejects prose and incomplete reviewer output", async () => {
    expect(Exit.isFailure(await Effect.runPromiseExit(WorkReviewer.parse("Looks good")))).toBe(true)
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          WorkReviewer.parse('{"criteria":[{"criterionID":"criterion_review","verdict":"pass"}]}'),
        ),
      ),
    ).toBe(true)
  })
})
