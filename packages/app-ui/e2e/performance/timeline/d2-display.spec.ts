import { expect, test } from "@playwright/test"
import { fixture } from "./session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressSessionHref,
} from "./timeline-test-helpers"

test("permission deduplicates shared rules while preserving distinct current and remembered scopes", async ({
  page,
}) => {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.route("**/api/permission/request*", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: "per_d2",
            sessionID: fixture.sourceID,
            action: "bash",
            resources: ["echo D2", "echo D2", "pwd"],
            save: ["echo D2", "echo future *"],
          },
        ],
      },
    }),
  )
  await page.goto(stressSessionHref(fixture.sourceID))
  await page.locator('[data-slot="permission-row"] summary').click()
  await expect(page.locator('[data-slot="permission-row"] code').filter({ hasText: /^echo D2$/ })).toHaveCount(1)
  await expect(page.locator('[data-slot="permission-row"]')).toContainText(["bash"])
  await expect(page.getByText("echo future *", { exact: true })).toBeVisible()
  await expect(page.getByText("pwd", { exact: true })).toBeVisible()
  await expect(
    page.getByText("This item is also included in remembered permissions for future requests in this project.", {
      exact: true,
    }),
  ).toBeVisible()
})

test("cost estimates show mixed models, missing price and unknown history separately", async ({ page }) => {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  const total = {
    input: 100,
    output: 10,
    reasoning: 5,
    cacheRead: 20,
    cacheWrite: 0,
    total: 135,
    calls: 1,
    unreported: 0,
  }
  await page.route("**/api/usage*", (route) =>
    route.fulfill({
      json: {
        data: {
          total,
          own: total,
          official: total,
          unknown: total,
          lastTurn: total,
          updatedAt: 1,
          billing: "unavailable",
          models: [
            { providerID: "fixture", modelID: "priced", tokens: total, priceConfigured: true, estimate: 0.123456 },
            { providerID: "fixture", modelID: "free", tokens: total, priceConfigured: true, estimate: 0 },
            { providerID: "fixture", modelID: "no-price", tokens: total, priceConfigured: false, estimate: null },
            { providerID: null, modelID: null, tokens: total, priceConfigured: false, estimate: null },
          ],
        },
      },
    }),
  )
  await page.goto(stressSessionHref(fixture.sourceID))
  await page.locator(".session-usage-bar").click()
  const card = page.getByRole("region", { name: "Estimated cost by model" })
  await expect(card).toContainText("USD 0.123456")
  await expect(card).toContainText("USD 0.000000")
  await expect(card).toContainText("Price not configured")
  await expect(card).toContainText("Unknown / Unknown")
  await expect(card).toContainText("not a bill")
})

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
    const card = page.locator(".session-usage-details .usage-card").first()
    await expect(card).toBeVisible()
    await expect(card).toContainText(unreported ? "Unknown" : "60.0%")
    await expect(card.locator("dl")).toContainText(unreported ? "≥ 10" : "10")
    await expect(page.locator(".session-usage-details")).toContainText("Estimated cost by model")
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
