import { describe, expect, test } from "bun:test"
import { WorkRole } from "@zaovra-ai/core/work/role"
import { Work } from "@zaovra-ai/schema/work"
import { DateTime } from "effect"

describe("WorkRole", () => {
  test("maps organization roles to isolated runtime Agents and workspace permissions", () => {
    expect(String(WorkRole.agentID("developer"))).toBe("work-developer")
    expect(String(WorkRole.agentID("qa"))).toBe("work-qa")
    expect(WorkRole.get("security")).toMatchObject({
      workspaceAccess: "read_only",
      capabilities: ["research", "verify", "audit"],
    })
    expect(WorkRole.allowsIsolation("developer", "worktree")).toBe(true)
    expect(WorkRole.allowsIsolation("qa", "worktree")).toBe(false)
  })

  test("enforces publishing, project keys, and expiry metadata at the Handoff boundary", () => {
    const expiresAt = DateTime.makeUnsafe(10_000)
    const normalized = WorkRole.normalizeHandoff(
      "qa",
      Work.HandoffOutput.make({
        summary: "Quality review complete",
        items: [
          { kind: "decision", text: "QA cannot publish architecture decisions" },
          { kind: "fact", text: "Tests cover recovery", memory: "project" },
          { kind: "lesson", text: "Keep failure evidence", memory: "project", key: "qa.failure-evidence", expiresAt },
        ],
      }),
    )

    expect(normalized.items).toEqual([
      { kind: "fact", text: "Tests cover recovery", memory: "task" },
      {
        kind: "lesson",
        text: "Keep failure evidence",
        memory: "project",
        key: "qa.failure-evidence",
        expiresAt,
      },
    ])
  })

  test("filters routed Handoff items through the consumer Role Contract", () => {
    const handoff = Work.HandoffInfo.make({
      id: Work.HandoffID.make("handoff_role"),
      goalID: Work.GoalID.make("goal_role"),
      taskID: Work.TaskID.make("task_role"),
      attemptID: Work.AttemptID.make("attempt_role"),
      producer: "qa",
      summary: "Reviewed",
      items: [
        { kind: "lesson", text: "A historical lesson" },
        { kind: "risk", text: "A current risk" },
      ],
      evidenceIDs: [],
      recipients: [Work.TaskID.make("task_consumer")],
      digest: "a".repeat(64),
      createdAt: DateTime.makeUnsafe(1),
    })

    expect(WorkRole.acceptsHandoff("developer", handoff).map((item) => item.kind)).toEqual(["risk"])
    expect(WorkRole.acceptsHandoff("architect", handoff).map((item) => item.kind)).toEqual(["lesson", "risk"])
  })
})
