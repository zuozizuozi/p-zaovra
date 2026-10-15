import { expect, test } from "@playwright/test"
import { installStressSessionTabs, installTimelineSettings, mockStressTimeline } from "./timeline-test-helpers"

for (const width of [1280, 390]) {
  test(`root opens the real composer directly at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await mockStressTimeline(page)
    await installTimelineSettings(page)
    await installStressSessionTabs(page)
    await page.goto("/")
    await expect(page).toHaveURL(/\/new-session\?draftId=/)
    const composer = page.locator('[contenteditable="true"]').first()
    await expect(composer).toBeVisible()
    await expect(page.locator(".home-welcome")).toHaveCount(0)
    await composer.fill("Keep this task in the real composer")
    await expect(composer).toContainText("Keep this task")
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
