import { test, expect } from "@playwright/test"
import { setupTimeline } from "../performance/timeline-stability/fixture"

test.skip(process.env.ZAOVRA_UPDATER_TEST !== "1", "Requires the isolated updater platform fixture")

// Run the UI server with --config e2e/updater-vite.config.ts.
for (const newLayoutDesigns of [true, false]) {
  test(`layout ${newLayoutDesigns}: available notification requires consent, supports later and leads to restart after download`, async ({
    page,
  }, info) => {
    let downloads = 0
    let installs = 0
    await page.route("**/test-updater/download", (route) => {
      downloads += 1
      return route.fulfill({ json: { status: "ready", version: "2.0.0" } })
    })
    await page.route("**/test-updater/install", (route) => {
      installs += 1
      return route.fulfill({ json: {} })
    })
    await setupTimeline(page, { locale: "en", settings: { newLayoutDesigns } })
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("test:updater", { detail: { status: "available", version: "1.5.0" } })),
    )
    const toast = page
      .locator('[data-component="toast"], [data-component="toast-v2"]')
      .filter({ hasText: "Version 1.5.0 is available" })
    await expect(toast.getByRole("button", { name: "Download update", exact: true })).toBeVisible()
    expect(downloads).toBe(0)
    await toast.getByRole("button", { name: "Not yet", exact: true }).click()
    await expect(toast).toHaveCount(0)
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("test:updater", { detail: { status: "available", version: "1.5.0" } })),
    )
    await expect(toast).toHaveCount(0)
    expect(downloads).toBe(0)
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent("test:updater", { detail: { status: "available", version: "2.0.0" } })),
    )
    const next = page
      .locator('[data-component="toast"], [data-component="toast-v2"]')
      .filter({ hasText: "Version 2.0.0 is available" })
    await expect(next.getByRole("button", { name: "Download update", exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath("available.png") })
    expect(downloads).toBe(0)
    await next.getByRole("button", { name: "Download update", exact: true }).click()
    await expect(
      page
        .locator('[data-component="toast"], [data-component="toast-v2"]')
        .getByRole("button", { name: "Install and restart", exact: true }),
    ).toBeVisible()
    expect(downloads).toBe(1)
    expect(installs).toBe(0)
    await page
      .locator('[data-component="toast"], [data-component="toast-v2"]')
      .getByRole("button", { name: "Install and restart", exact: true })
      .click()
    await expect.poll(() => installs).toBe(1)
  })
}

test("download failure is visible and a notification can be dismissed", async ({ page }) => {
  let downloads = 0
  await page.route("**/test-updater/download", (route) => {
    downloads += 1
    return route.fulfill({ json: { status: "error", message: "Fixture download failure" } })
  })
  await setupTimeline(page, { locale: "en" })
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("test:updater", { detail: { status: "available", version: "2.0.0" } })),
  )
  const toast = page
    .locator('[data-component="toast"], [data-component="toast-v2"]')
    .filter({ hasText: "Version 2.0.0 is available" })
  await toast.getByRole("button", { name: "Download update", exact: true }).click()
  await expect(page.getByText("Fixture download failure", { exact: true })).toBeVisible()
  expect(downloads).toBe(1)
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("test:updater", { detail: { status: "available", version: "3.0.0" } })),
  )
  const next = page
    .locator('[data-component="toast"], [data-component="toast-v2"]')
    .filter({ hasText: "Version 3.0.0 is available" })
  await next.locator('[data-slot="toast-close-button"], [data-slot="toast-v2-close-button"]').click()
  await expect(next).toHaveCount(0)
  expect(downloads).toBe(1)
})
