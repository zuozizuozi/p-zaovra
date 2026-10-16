import { expect, test } from "@playwright/test"
import { installStressSessionTabs, installTimelineSettings, mockStressTimeline } from "./timeline-test-helpers"

for (const action of ["backdrop", "close", "escape"] as const) {
  test(`command palette cancels with ${action} without changing the draft`, async ({ page }) => {
    await mockStressTimeline(page)
    await installTimelineSettings(page)
    await installStressSessionTabs(page)
    await page.goto("/")
    const input = page.locator('[data-component="prompt-input-v2"] [contenteditable="true"]').first()
    await expect(input).toBeVisible()
    await input.fill("Keep this unsent task")
    const href = page.url()
    await page
      .locator('[data-component="desktop-rail"]')
      .getByRole("button", { name: "Command palette", exact: true })
      .click()
    const palette = page.locator(".command-palette-v2")
    await expect(palette).toBeVisible()
    await palette.locator("input").fill("no matching command 123")
    await expect(palette.locator("input")).toHaveValue("no matching command 123")
    if (action === "backdrop")
      await page.locator('[data-component="dialog-overlay"]').click({ position: { x: 20, y: 100 } })
    if (action === "close") await palette.getByRole("button", { name: "Close", exact: true }).click()
    if (action === "escape") await palette.locator("input").press("Escape")
    await expect(palette).toHaveCount(0)
    await expect(page.locator('[data-component="dialog-overlay"]')).toHaveCount(0)
    await expect(input).toContainText("Keep this unsent task")
    await expect(page).toHaveURL(href)
    await input.fill("Still editable after dismissal")
    await expect(input).toContainText("Still editable after dismissal")
  })
}
