import { test, expect } from "@playwright/test"
import { mockZaovraServer } from "../../utils/mock-server"
import { fixture, pageMessages } from "./session-timeline-stress.fixture"
import { installStressSessionTabs, installTimelineSettings } from "./timeline-test-helpers"

test("usage synchronizes after execution finishes and both dashboard entry points work", async ({ page }) => {
  let emit = false
  let completed = false
  let waiting = false
  let unavailable = false
  let release = () => {}
  const settled = new Promise<void>((resolve) => {
    release = resolve
  })
  await mockZaovraServer(page, {
    sessions: fixture.sessions,
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    pageMessages,
    eventRetry: 100,
    events: () => {
      if (!emit) return []
      emit = false
      return [
        {
          directory: fixture.directory,
          payload: {
            type: "session.next.step.ended",
            properties: {
              sessionID: fixture.sourceID,
              assistantMessageID: "msg_usage_end",
              timestamp: Date.now(),
              finish: "stop",
            },
          },
        },
      ]
    },
  })
  await page.route(/\/api\/session\/[^/]+\/wait(?:\?|$)/, async (route) => {
    waiting = true
    await settled
    await route.fulfill({ json: {} })
  })
  const totals = (total: number) => ({
    input: total,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total,
    calls: total ? 1 : 0,
    unreported: 0,
  })
  await page.route(/\/api\/usage(?:\?|$)/, (route) => {
    if (unavailable) return route.fulfill({ status: 503, json: { message: "Unavailable" } })
    return route.fulfill({
      json: {
        data: {
          total: totals(completed ? 495 : 100),
          own: totals(completed ? 330 : 100),
          official: totals(completed ? 165 : 0),
          unknown: totals(0),
          lastTurn: totals(completed ? 395 : 100),
          updatedAt: Date.now(),
          billing: "unavailable",
        },
      },
    })
  })
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.goto("/")
  const welcome = page.getByRole("region", { name: "What will we create today?" })
  await welcome.getByRole("textbox").fill("Keep my draft")
  await welcome.getByRole("button", { name: "Continue to session" }).click()
  const bar = page.getByRole("button", { name: "Usage dashboard", exact: true })
  await expect(bar).toContainText("Conversation 0")
  await page.locator(`a[href*="${fixture.sourceID}"]`).first().click()
  await expect(bar).toContainText("Conversation 100")
  emit = true
  await expect.poll(() => waiting).toBe(true)
  await expect(bar).toContainText("Conversation 100")
  completed = true
  release()
  await expect(bar).toContainText("Conversation 495")
  await expect(bar).toContainText("Last turn 395")
  await page.screenshot({ path: "../../quality/usage-composer.png" })
  await bar.click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("tab", { name: "Usage dashboard" })).toHaveAttribute("aria-selected", "true")
  await expect(dialog.getByRole("region", { name: "Own Key", exact: true })).toContainText("330")
  await expect(dialog.getByRole("region", { name: "Official service", exact: true })).toContainText("165")
  await expect(dialog.getByText("Account data not connected", { exact: true })).toHaveCount(2)
  await page.screenshot({ path: "../../quality/usage-dashboard.png" })
  unavailable = true
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect(dialog.getByRole("region", { name: "Own Key", exact: true })).toHaveCount(0)
  unavailable = false
  await dialog.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(dialog.getByRole("region", { name: "Own Key", exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await bar.click()
  await dialog.getByRole("tab", { name: "General", exact: true }).click()
  await dialog.getByRole("tab", { name: "Usage dashboard" }).click()
  await expect(dialog.getByRole("region", { name: "Official service", exact: true })).toBeVisible()
  await page.setViewportSize({ width: 900, height: 650 })
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeVisible()
  await page.screenshot({ path: "../../quality/usage-dashboard-compact.png" })
})
