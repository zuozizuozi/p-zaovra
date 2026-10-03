import { expect, test } from "@playwright/test"
import { setupTimeline } from "../performance/timeline-stability/fixture"

test("uses host replacement markers and keeps unresolved checks visible", async ({ page }) => {
  await setupTimeline(page, { locale: "en", settings: { newLayoutDesigns: true } })
  await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
  const command = `npm test -- ${"long-target/".repeat(40)}spec.ts`
  await page.route("**/api/session/*/outcome**", (route) =>
    route.fulfill({
      json: {
        data: {
          state: "completed",
          outcomeUnknown: false,
          missing: [],
          checks: [
            { kind: "test", command, exit: 1, callID: "old", supersededBy: "new" },
            { kind: "test", command, exit: 0, callID: "new", logs: ["ev_private_detail"] },
            { kind: "test", command, exit: 1, callID: "unresolved" },
            { kind: "syntax", command: "compile", exit: -1, execution: "not-run", callID: "not-run" },
            { kind: "smoke", command: "smoke", exit: -1, execution: "timeout", callID: "timeout" },
            { kind: "lint", command: "lint", exit: 0, execution: "invalid-report", callID: "invalid" },
          ],
        },
      },
    }),
  )
  await page.reload()
  const summary = page.locator('[data-component="verification-summary"]')
  await expect(summary).toContainText("1 current checks passed")
  await expect(summary).toContainText("1 checks failed")
  await expect(summary).toContainText("3 checks did not produce a valid result")
  const history = page.locator('[data-component="verification-history"]')
  await expect(history).not.toHaveAttribute("open", "")
  await expect(history.locator(".text-icon-critical-base")).toHaveCount(0)
  const current = page.locator('[data-component="verification-current"]')
  await expect(current.locator(":scope > details")).toHaveCount(5)
  await expect(current.locator(":scope > details.text-icon-critical-base")).toHaveCount(4)
  const passed = current.locator(":scope > details").first()
  await expect(passed.locator("pre")).not.toBeVisible()
  await expect(passed.getByText("ev_private_detail", { exact: true })).not.toBeVisible()
  expect(await passed.locator("summary .truncate").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await passed.locator("summary").click()
  await expect(passed.locator("pre")).toHaveText(command)
  await expect(passed.getByText("ev_private_detail", { exact: true })).toBeVisible()
  await history.locator(":scope > summary").click()
  await history.locator("details > summary").click()
  await expect(history.getByText("old", { exact: true })).toBeVisible()
})

test("does not turn missing evidence or unknown results into task verification", async ({ page }) => {
  await setupTimeline(page, { locale: "en", settings: { newLayoutDesigns: true } })
  await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
  await page.route("**/api/session/*/outcome**", (route) =>
    route.fulfill({
      json: { data: { state: "completed", outcomeUnknown: true, checks: [], missing: ["requirements"] } },
    }),
  )
  await page.reload()
  await expect(page.locator('[data-component="verification-summary"]')).toHaveText(
    "Verification information · No current checks",
  )
  await expect(page.getByText("Requirement coverage has not been recorded", { exact: false })).toBeVisible()
  await expect(
    page
      .locator('[role="status"]')
      .filter({ has: page.locator('[data-component="verification-summary"]') })
      .locator('[role="alert"]'),
  ).toHaveCount(2)
  await expect(page.locator('[data-component="verification-history"]')).toHaveCount(0)
})
