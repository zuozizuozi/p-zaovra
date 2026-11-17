import { expect, test } from "@playwright/test"
import { fixture } from "../timeline/session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressDraftHref,
  stressSessionHref,
} from "../timeline/timeline-test-helpers"

for (const fault of ["network", "server"]) {
  test(`directory ${fault} failure keeps navigation and retries without removing the draft`, async ({ page }) => {
    await mockStressTimeline(page)
    await installTimelineSettings(page)
    await installStressSessionTabs(page, { draftID: "connection_recovery" })
    let failed = true
    let faults = 0
    await page.route(/\/api\/location(?:\?|$)/, (route) => {
      if (!failed) return route.fallback()
      faults++
      if (fault === "network") return route.abort("failed")
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "temporary unavailable" }),
      })
    })
    await page.goto(stressDraftHref("connection_recovery"))
    const status = page.getByRole("status").filter({ hasText: "Request failed" })
    await expect(status).toBeVisible()
    expect(faults).toBeGreaterThan(0)
    await expect(status).toContainText(fixture.directory)
    await expect(status.getByRole("button", { name: "Remove from list", exact: true })).toHaveCount(0)
    await expect(page.getByRole("banner").getByRole("button", { name: "Home", exact: true })).toBeVisible()
    await expect(page).toHaveURL(/draftId=connection_recovery/)
    const beforeRetry = faults
    await status.getByRole("button", { name: "Retry", exact: true }).click()
    await expect.poll(() => faults).toBeGreaterThan(beforeRetry)
    await expect(status).toBeVisible()
    failed = false
    await status.getByRole("button", { name: "Retry", exact: true }).click()
    await expect(page.locator('[data-component="prompt-input"][contenteditable="true"]')).toBeVisible()
    await expect(status).toHaveCount(0)
    await expect(page).toHaveURL(/draftId=connection_recovery/)
  })
}

test("confirmed missing directory retains its distinct recovery choices", async ({ page }) => {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.route(/\/api\/location(?:\?|$)/, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ name: "DirectoryUnavailableError", data: { directory: fixture.directory } }),
    }),
  )
  await page.goto(stressSessionHref(fixture.sourceID))
  const status = page.getByRole("status").filter({ hasText: "Directory unavailable" })
  await expect(status).toBeVisible()
  await expect(status.getByRole("button", { name: "Remove from list", exact: true })).toBeVisible()
  await expect(status.getByRole("button", { name: "Choose another project", exact: true })).toBeVisible()
  await expect(page.getByRole("banner").getByRole("button", { name: "Home", exact: true })).toBeVisible()
})
