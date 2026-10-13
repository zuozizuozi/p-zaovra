import { expect, test } from "@playwright/test"
import { Work } from "@zaovra-ai/schema/work"
import { setupTimeline, directory } from "./fixture"

for (const locale of ["en", "zh"] as const) {
  test(`Work badges render schema states and literal labels in ${locale}`, async ({ page }) => {
    await setupTimeline(page, { locale, settings: { newLayoutDesigns: true } })
    const goals = Work.GoalStatus.literals.map((status, index) => ({
      id: `goal_badge_${index}`,
      location: { directory },
      objective: `Goal ${status}`,
      status,
      usage: { attempts: 0, repairs: 0 },
      acceptanceCriteria: [],
      time: { created: 1, updated: 1 },
      revision: 1,
    }))
    const goal = goals[0]
    const detail = {
      goal,
      tasks: Work.TaskStatus.literals.map((status, index) => ({
        id: `task_badge_${index}`,
        goalID: goal.id,
        title: `Task ${status}`,
        instructions: "Local fixture",
        dependsOn: [],
        role: index === 0 ? "custom-role" : "developer",
        status,
        criteria: [],
        attemptCount: 0,
        time: { created: 1, updated: 1 },
        revision: 1,
      })),
      attempts: Work.AttemptStatus.literals.map((status, index) => ({
        id: `attempt_badge_${index}`,
        goalID: goal.id,
        taskID: "task_badge_0",
        status,
        kind: Work.AttemptKind.literals[index % Work.AttemptKind.literals.length],
        number: 1,
      })),
      evidence: Work.EvidenceKind.literals.map((kind, index) => ({
        id: `evidence_${index}`,
        kind,
        producer: "fixture",
        payload: {},
      })),
      evaluations: Work.Verdict.literals.map((verdict) => ({
        verdict,
        evaluator: "fixture",
        evidenceIDs: [],
        findings: [],
      })),
      handoffs: [
        { producer: "custom-producer", taskID: "task_badge_0", summary: "Local fixture", recipients: [], items: [] },
      ],
      roles: ["write", "read_only"].map((workspaceAccess) => ({
        id: workspaceAccess,
        title: workspaceAccess,
        agentID: "fixture",
        purpose: "Local fixture",
        workspaceAccess,
        capabilities: [],
        allowedIsolation: [],
      })),
      memory: { entries: [] },
    }
    await page.route("**/api/work", (route) => route.fulfill({ json: { data: goals } }))
    await page.route(`**/api/work/${goal.id}`, (route) => route.fulfill({ json: { data: detail } }))
    await page.route(`**/api/work/${goal.id}/merge/*`, (route) =>
      route.fulfill({ status: 409, json: { message: "Fixture has no merge" } }),
    )
    await page.goto(`/work/${goal.id}`)
    const badges = page.locator('[data-component="work-status"]')
    for (const value of new Set([
      ...Work.GoalStatus.literals,
      ...Work.TaskStatus.literals,
      ...Work.AttemptStatus.literals,
      ...Work.AttemptKind.literals,
      ...Work.EvidenceKind.literals,
      ...Work.Verdict.literals,
    ])) {
      const badge = badges.and(page.locator(`[data-value="${value}"]`)).first()
      await expect(badge).toContainText(/\S/)
      await expect(badge).not.toContainText("work.status.")
      if (locale === "zh") await expect(badge).toContainText(/[\u3400-\u9fff]/)
    }
    await expect(badges.filter({ hasText: locale === "zh" ? "可编辑" : "can edit" })).toHaveCount(1)
    await expect(badges.filter({ hasText: locale === "zh" ? "只读" : "read only" })).toHaveCount(1)
    await expect(badges.and(page.locator('[data-value="custom-role"]'))).toHaveText("custom-role")
    await expect(badges.and(page.locator('[data-value="custom-producer"]'))).toHaveText("custom-producer")
  })
}
