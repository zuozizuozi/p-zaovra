import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, shell, userMessage } from "./fixture"

test("long tool feedback stays bounded and animated scrolling matches reduced motion", async ({ page }, testInfo) => {
  await setupTimeline(page, {
    seedHistory: true,
    messages: [
      userMessage(),
      assistantMessage([shell("prt_activity", "running", "", "npm test")], { completed: false }),
    ],
  })
  const activity = page.locator('[data-component="task-activity"]')
  await expect(activity).toHaveAttribute("data-state", "working")
  await expect(activity.locator('[data-slot="activity-command"]')).toHaveText("npm test", { timeout: 15000 })
  const height = await activity.evaluate((element) => element.getBoundingClientRect().height)
  const measure = () =>
    page
      .locator(".scroll-view__viewport")
      .filter({ has: activity })
      .evaluate(async (element) => {
        const times: number[] = []
        let previous = performance.now()
        for (let i = 0; i < 120; i++) {
          await new Promise(requestAnimationFrame)
          const now = performance.now()
          times.push(now - previous)
          previous = now
          element.scrollTop = ((i % 60) / 59) * (element.scrollHeight - element.clientHeight)
        }
        return times
      })
  const animated = await measure()
  await page.emulateMedia({ reducedMotion: "reduce" })
  const reduced = await measure()
  await expect(activity).toContainText("Running")
  expect(await activity.evaluate((element) => element.getBoundingClientRect().height)).toBe(height)
  expect(await activity.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0)
  await testInfo.attach("scroll-frames", {
    body: JSON.stringify({ animated, reduced, height }),
    contentType: "application/json",
  })
  // Broad regression bound, not a claim of statistically significant improvement.
  const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)]!
  expect(p95(animated)).toBeLessThan(Math.max(50, p95(reduced) * 2))
})
