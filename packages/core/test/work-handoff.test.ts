import { describe, expect, test } from "bun:test"
import { Work } from "@zaovra-ai/schema/work"
import { WorkHandoff } from "@zaovra-ai/core/work/handoff"

describe("WorkHandoff", () => {
  test("extracts a bounded structured Handoff from an executor response", () => {
    const output = WorkHandoff.parse(`Implemented the change.

<work-handoff>
{"summary":"Implemented durable mailboxes","items":[{"kind":"decision","text":"Downstream Tasks consume Handoffs"},{"kind":"artifact","text":"Added tests","reference":"packages/core/test/work-handoff.test.ts"}]}
</work-handoff>`)

    expect(output).toEqual({
      summary: "Implemented durable mailboxes",
      items: [
        { kind: "decision", text: "Downstream Tasks consume Handoffs" },
        { kind: "artifact", text: "Added tests", reference: "packages/core/test/work-handoff.test.ts" },
      ],
    })
  })

  test("falls back to an explicit result item when legacy output has no contract block", () => {
    expect(WorkHandoff.parse("Legacy task summary")).toEqual({
      summary: "Legacy task summary",
      items: [{ kind: "result", text: "Legacy task summary" }],
    })
  })

  test("uses deterministic task identity and content digests", () => {
    const taskID = Work.TaskID.make("task_handoff")
    const output = Work.HandoffOutput.make({ summary: "done", items: [{ kind: "fact", text: "verified" }] })
    expect(WorkHandoff.id(taskID)).toBe(WorkHandoff.id(taskID))
    expect(WorkHandoff.digest(output, [])).toHaveLength(64)
  })
})
