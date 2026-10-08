import { expect, test } from "@playwright/test"
import { fixture } from "./session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressSessionHref,
} from "./timeline-test-helpers"

for (const unreported of [0, 1]) {
  test(`session usage is explicit with ${unreported} unreported calls`, async ({ page }) => {
    await mockStressTimeline(page)
    await installTimelineSettings(page)
    await installStressSessionTabs(page)
    const totals = {
      input: 30,
      cacheRead: 60,
      cacheWrite: 10,
      output: 8,
      reasoning: 2,
      total: 110,
      calls: 1,
      unreported,
    }
    await page.route("**/api/usage*", (route) =>
      route.fulfill({
        json: {
          data: {
            total: totals,
            own: totals,
            official: totals,
            unknown: totals,
            lastTurn: totals,
            updatedAt: 1,
            billing: "unavailable",
          },
        },
      }),
    )
    await page.goto(stressSessionHref(fixture.sourceID))
    await page.locator(".session-usage-bar").click()
    const card = page.locator(".session-usage-details .usage-card")
    await expect(card).toBeVisible()
    await expect(card).toContainText(unreported ? "Unknown" : "60.0%")
    await expect(card.locator("dl")).toContainText(unreported ? "≥ 10" : "10")
    await expect(card).toContainText("Cost estimate unavailable")
  })
}

test("unreadable merge baseline stays local and cannot approve; refresh can recover", async ({ page }) => {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  const goal = {
    id: "goal_d2",
    location: { directory: fixture.directory },
    objective: "D2 merge review",
    acceptanceCriteria: [],
    status: "completed",
    usage: { attempts: 0, repairs: 0 },
    time: { created: 1, updated: 1 },
    revision: 1,
  }
  const detail = {
    goal,
    tasks: [
      {
        id: "task_d2",
        goalID: goal.id,
        title: "Pending merge",
        instructions: "Review only",
        dependsOn: [],
        role: "developer",
        status: "merging",
        criteria: [],
        attemptCount: 0,
        time: { created: 1, updated: 1 },
        revision: 1,
      },
    ],
    attempts: [],
    evidence: [],
    evaluations: [],
    handoffs: [],
    roles: [],
    memory: { entries: [] },
  }
  await page.route("**/api/work", (route) => route.fulfill({ json: { data: [goal] } }))
  await page.route("**/api/work/goal_d2", (route) => route.fulfill({ json: { data: detail } }))
  let readable = false
  await page.route("**/api/work/goal_d2/merge/task_d2", (route) =>
    route.fulfill(
      readable
        ? {
            json: {
              baseline: "baseline",
              diff: "example diff",
              token: "fixture-token",
              reason: "Baseline changed; review required",
            },
          }
        : { status: 409, json: { message: "Cannot read merge baseline" } },
    ),
  )
  const decisions: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/merge/")) decisions.push(request.url())
  })
  await page.goto("/work/goal_d2")
  await expect(page.getByText("无法读取合并基线或改动", { exact: false })).toBeVisible()
  await expect(page.getByRole("button", { name: "批准并应用", exact: true })).toHaveCount(0)
  readable = true
  await page.getByRole("button", { name: "刷新改动", exact: true }).click()
  await expect(page.getByText("example diff", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "批准并应用", exact: true })).toBeDisabled()
  expect(decisions).toEqual([])
})
