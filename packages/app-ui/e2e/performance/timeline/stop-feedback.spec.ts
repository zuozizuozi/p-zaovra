import { expect, test } from "@playwright/test"
import { setupTimelineBenchmark } from "./session-timeline-benchmark.fixture"

test("a rejected Stop is visible and repeated clicks share the pending request", async ({ page }) => {
  const fixture = await setupTimelineBenchmark(page, {
    historyTurns: 0,
    eventBatch: 1,
    newLayoutDesigns: true,
    awaitingProvider: true,
  })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  await page.route("**/api/session/*/interrupt", async (route) => {
    requests++
    await gate
    await route.fulfill({ status: 503, json: { message: "Stop unavailable; execution may still be running" } })
  })
  const stop = page.getByRole("button", { name: "Stop", exact: true })
  try {
    await expect(stop).toBeVisible()
    await stop.click()
    await expect.poll(() => requests).toBe(1)
    await stop.click()
    expect(requests).toBe(1)
    await expect(fixture.scroller).toBeVisible()
  } finally {
    release()
  }
  await expect(page.getByText(/Stop unavailable/)).toBeVisible()
  await expect(stop).toBeVisible()
})

test("a pending outcome request does not hide the conversation", async ({ page }) => {
  const fixture = await setupTimelineBenchmark(page, { historyTurns: 0, newLayoutDesigns: true })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  await page.route(/\/api\/session\/[^/]+\/outcome(?:\?|$)/, async (route) => {
    requests++
    await gate
    await route.fulfill({
      json: { data: { state: "completed_unverified", checks: [], missing: ["acceptance"], outcomeUnknown: false } },
    })
  })
  try {
    await page.reload()
    await expect.poll(() => requests).toBeGreaterThan(0)
    await expect(fixture.scroller).toBeVisible()
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible()
  } finally {
    release()
  }
})
