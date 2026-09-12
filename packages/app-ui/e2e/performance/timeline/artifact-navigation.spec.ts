import { test, expect } from "@playwright/test"
import { installStressSessionTabs, installTimelineSettings, mockStressTimeline } from "./timeline-test-helpers"
test("records welcome to composer production navigation", async ({ page }) => {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.goto("/")
  const welcome = page.getByRole("region", { name: "What will we create today?" })
  await expect(welcome).toBeVisible()
  await welcome.getByRole("textbox").fill("Artifact preview navigation baseline")
  const start = Date.now()
  await welcome.getByRole("button", { name: "Continue to session" }).click()
  await expect(page.locator('[data-component="prompt-input"][contenteditable="true"]').first()).toContainText("Artifact preview navigation baseline")
  console.log("ARTIFACT_NAVIGATION_MS", Date.now() - start)
})
