import { expect, test } from "@playwright/test"
import { assistantID, assistantMessage, sessionID, setupTimeline, textPart, userMessage } from "./fixture"

test("S1 stopped budget offers inspect and continue without claiming success", async ({ page }) => {
  const assistant = assistantMessage([textPart("prt_stopped", "Budget reached; work remains.")])
  await setupTimeline(page, {
    messages: [userMessage(), { ...assistant, info: { ...assistant.info, finish: "stopped" } }],
  })
  await page.route("**/session/*/outcome*", (route) =>
    route.fulfill({
      json: {
        data: {
          state: "stopped",
          runtime: "stopped",
          verification: "unverified",
          messageID: assistantID,
          termination: { category: "budget", message: "Budget reached; work remains." },
          outcomeUnknown: false,
          checks: [],
          missing: [],
        },
      },
    }),
  )
  await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
  await page.reload()
  await expect(
    page
      .locator('[data-component="session-recovery-actions"]')
      .getByRole("button", { name: "Inspect and continue", exact: true }),
  ).toBeVisible()
  await expect(page.locator('[data-component="session-termination"]')).toContainText("Budget reached")
  await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible()
  await page.locator('[data-component="session-budget"] > summary').click()
  await expect(page.getByRole("button", { name: "Remove limits and continue", exact: true })).toBeVisible()
  const requests: { kind: string; body: unknown }[] = []
  await page.route(`**/api/session/${sessionID}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    requests.push({ kind: "update", body: route.request().postDataJSON() })
    await route.fulfill({ json: { data: {} } })
  })
  await page.route(`**/api/session/${sessionID}/recover`, async (route) => {
    requests.push({ kind: "recover", body: route.request().postDataJSON() })
    await route.fulfill({ json: { data: { state: "running" } } })
  })
  await page.getByLabel("Total tokens", { exact: true }).fill("10000")
  await page.getByLabel("Total minutes", { exact: true }).fill("60")
  await page.getByRole("button", { name: "Apply limits and continue", exact: true }).click()
  await expect.poll(() => requests.length).toBe(2)
  expect(requests).toEqual([
    { kind: "update", body: { budget: { tokens: 10000, durationMs: 3600000 } } },
    { kind: "recover", body: { messageID: assistantID, action: "continue" } },
  ])
  await page.getByRole("button", { name: "Remove limits and continue", exact: true }).click()
  await expect.poll(() => requests.length).toBe(4)
  expect(requests[2]).toEqual({ kind: "update", body: { budget: {} } })
  expect(requests[3]).toEqual({ kind: "recover", body: { messageID: assistantID, action: "continue" } })
})

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
    await expect(group.getByTitle("product.js", { exact: true })).toBeVisible()
  })
}
