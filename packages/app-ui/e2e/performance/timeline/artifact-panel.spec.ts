import { test, expect } from "@playwright/test"
import { installStressSessionTabs, installTimelineSettings, mockStressTimeline } from "./timeline-test-helpers"

test("792 removes the empty artifact entry and keeps the same file panel reachable in a narrow drawer", async ({
  page,
}) => {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.goto("/")
  const welcome = page.getByRole("region", { name: "What will we create today?" })
  await welcome.getByRole("textbox").fill("Inspect this session")
  await welcome.getByRole("button", { name: "Continue to session" }).click()
  await page.locator('a[href*="ses_smoke_source"]').first().click()
  await page.getByRole("button", { name: "更多选项", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "查看成果", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-component="artifacts-panel"]')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 900 })
  await expect(page.getByRole("tab", { name: "会话", exact: true })).toHaveCount(0)
  await page.locator('[data-component="session-panel-controls"]').getByRole("button").first().click()
  const drawer = page.locator('dialog[data-component="session-side-drawer"]')
  await expect(drawer).toBeVisible()
  await expect(drawer.locator("#review-panel")).toHaveAttribute("aria-hidden", "false")
  await page.keyboard.press("Escape")
  await expect(drawer).toBeHidden()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
