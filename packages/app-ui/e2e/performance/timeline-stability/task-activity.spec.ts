import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, shell, userMessage,
  status, userID } from "./fixture"

test("long tool feedback stays bounded and animated scrolling matches reduced motion", async ({ page }, testInfo) => {
  await setupTimeline(page, {
    seedHistory: true,
    messages: [
      userMessage(),
      assistantMessage([shell("prt_activity", "running", "", "npm test")], { completed: false }),
    ],
  })
  const activity = page.locator(
    `[data-timeline-row="AssistantHeading"][data-message-id="${userID}"] [data-component="task-activity"]`,
  )
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

test("mascot blinks while visible and suspends offscreen or with reduced motion", async ({ page }) => {
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([], { completed: false })],
  })
  await timeline.send(status("busy"))
  const mascot = page.locator('[data-component="task-activity"] [data-component="task-mascot"]')
  await expect(mascot).toHaveAttribute("data-motion", "running")
  // Thinking shows the happy eye, so the closed eye only appears at the peak of a blink.
  const blinks = await mascot.evaluate(async (element) => {
    const closed = element.querySelector<SVGElement>('[data-part="eye-L"] [data-shape="closed"]')!
    const times: number[] = []
    const observer = new MutationObserver(() => {
      if (closed.style.display !== "none") times.push(performance.now())
    })
    observer.observe(closed, { attributes: true, attributeFilter: ["style"] })
    await new Promise((resolve) => setTimeout(resolve, 12500))
    observer.disconnect()
    return times
  })
  expect(blinks.length).toBeGreaterThanOrEqual(2)
  blinks.slice(1).forEach((time, index) => expect(time - blinks[index]).toBeLessThan(6500))
  const writes = () =>
    mascot.evaluate(async (element) => {
      let count = 0
      const observer = new MutationObserver((records) => (count += records.length))
      observer.observe(element.querySelector("svg")!, { attributes: true, subtree: true })
      await new Promise((resolve) => setTimeout(resolve, 700))
      observer.disconnect()
      return count
    })
  // Move the fixture outside the viewport to exercise the real IntersectionObserver.
  await mascot.evaluate((element) => (element.style.position = "fixed"))
  await mascot.evaluate((element) => (element.style.top = "-1000px"))
  await expect(mascot).toHaveAttribute("data-motion", "paused")
  await page.waitForTimeout(100)
  expect(await writes()).toBe(0)
  await mascot.evaluate((element) => element.removeAttribute("style"))
  await expect(mascot).toHaveAttribute("data-motion", "running")
  expect(await writes()).toBeGreaterThan(0)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(mascot).toHaveAttribute("data-motion", "paused")
  await page.waitForTimeout(100)
  expect(await writes()).toBe(0)
})
