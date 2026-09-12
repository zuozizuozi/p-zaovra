import { expect, test } from "@playwright/test"
import { base64Encode } from "@zaovra-ai/core/util/encode"
import { fixture } from "./session-timeline-stress.fixture"
import { installStressSessionTabs, installTimelineSettings, mockStressTimeline, stressDraftHref } from "./timeline-test-helpers"

for (const kind of ["session", "draft"]) {
  test(`missing ${kind} server displays a recoverable state instead of a fatal error`, async ({ page }) => {
    await mockStressTimeline(page)
    await installTimelineSettings(page)
    await installStressSessionTabs(page, { draftID: "missing_server_draft" })
    if (kind === "draft") {
      await page.addInitScript(() => {
        const key = "zaovra.window.browser.dat:tabs"
        const tabs = JSON.parse(localStorage.getItem(key)!)
        for (const tab of tabs) if (tab.type === "draft") tab.server = "wsl:missing"
        localStorage.setItem(key, JSON.stringify(tabs))
      })
    }
    await page.goto(kind === "session"
      ? `/server/${base64Encode("wsl:missing")}/session/${fixture.sourceID}`
      : stressDraftHref("missing_server_draft"))
    const unavailable = page.getByRole("status").filter({ hasText: "wsl:missing" })
    await expect(unavailable).toBeVisible()
    await unavailable.getByRole("button", { name: "Home", exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
  })
}
