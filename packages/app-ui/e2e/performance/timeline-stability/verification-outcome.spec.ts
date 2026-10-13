import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, textPart, userMessage } from "./fixture"

test("keeps host verification incomplete even when the assistant claims all tests passed", async ({ page }) => {
  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_claim", "All tests passed. The game is complete.")])],
  })
  await page.route("**/session/*/outcome*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          state: "completed_unverified",
          outcomeUnknown: false,
          checks: [
            {
              kind: "syntax",
              command: "check-game",
              exit: 0,
              callID: "syntax",
              targets: [{ path: "C:/desktop/game.html", digest: "v1" }],
              logs: ["ev_test_evidence"],
              requirements: ["Empty input is accepted"],
            },
            {
              kind: "test",
              command: "broken-inline-check",
              exit: 1,
              callID: "old",
              execution: "not-run",
              supersededBy: "syntax",
            },
          ],
          missing: ["smoke: C:/desktop/game.html", "interaction: C:/desktop/game.html", "requirements"],
        },
      }),
    }),
  )
  await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
  await page.reload()
  await expect(page.getByText("All tests passed. The game is complete.", { exact: true })).toBeVisible()
  const summary = page.locator('[data-component="verification-summary"]')
  await expect(summary).toContainText("Finished — verification incomplete")
  await summary.click()
  await page.locator('[data-component="verification-details"] > summary').click()
  await page.locator('[data-component="verification-explanation"] > summary').click()
  await page.locator('[data-component="verification-current"] > details > summary').click()
  await page.locator('[data-component="verification-current"] > details > details > summary').click()
  await expect(page.getByText("ev_test_evidence", { exact: true })).toBeVisible()
  await page.locator('[data-component="verification-history"] > summary').click()
  await page.locator('[data-component="verification-history"] > details > summary').click()
  await expect(page.getByText("Check did not run successfully", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Reported assertion coverage: Empty input is accepted", { exact: true })).toBeVisible()
  await expect(page.getByText(/Replaced by a passing check in the same scope:/)).toBeVisible()
  await expect(page.getByText(/Requirement coverage has not been recorded/)).toBeVisible()
  await expect(page.getByText(/interaction: C:\/desktop\/game.html/)).toBeVisible()
})

for (const warning of ["not-run", "stale", "failed"]) {
  test(`advisory ${warning} stays visible without downgrading run completion`, async ({ page }) => {
    await setupTimeline(page, {
      messages: [userMessage(), assistantMessage([textPart("prt_done", "Task finished; check details below.")])],
    })
    await page.route("**/session/*/outcome*", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            state: "completed",
            outcomeUnknown: false,
            checks: [
              {
                kind: "interaction",
                command: "node browser.cjs",
                exit: warning === "stale" ? 0 : 1,
                callID: "browser",
                ...(warning === "not-run" ? { execution: "not-run" } : {}),
                targets: [{ path: "product.js", digest: "v1" }],
              },
            ],
            missing: [`${warning}: interaction (browser)`],
          },
        }),
      }),
    )
    await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
    await page.reload()
    const summary = page.locator('[data-component="verification-summary"]')
    await expect(summary).toContainText("Finished ·")
    await expect(summary).not.toContainText("verification incomplete")
    await expect(summary).toHaveAttribute("data-warning", "")
    await summary.click()
    await page.locator('[data-component="verification-details"] > summary').click()
    await page.locator('[data-component="verification-explanation"] > summary').click()
    await expect(page.locator('[data-component="verification-explanation"]')).toContainText(
      `${warning}: interaction (browser)`,
    )
    const group = page.locator(
      `[data-component="verification-${warning === "stale" ? "stale" : warning === "failed" ? "unresolved" : "current"}"]`,
    )
    if (warning === "stale") await group.locator(":scope > summary").click()
    await group.locator(":scope > details > summary").click()
    await expect(page.getByText("product.js", { exact: true })).toBeVisible()
  })
}
