import { expect, test } from "@playwright/test"
import { assistantID, assistantMessage, sessionID, setupTimeline, textPart, userMessage } from "./fixture"

test("S1 displays effective default limits and keeps edits stable during live refresh", async ({ page }, info) => {
  await setupTimeline(page, { messages: [userMessage(), assistantMessage([textPart("prt_budget", "Working")])] })
  let tokens: number | undefined = 30_000_000
  let durationMs: number | undefined = 43_200_000
  let polls = 0
  await page.route(/\/api\/session\/[^/]+\/budget(?:\?|$)/, (route) => {
    polls++
    return route.fulfill({
      json: { data: { limits: { tokens, durationMs }, used: { tokens: 1200, durationMs: 60000 }, unreported: 0 } },
    })
  })
  await page.reload()
  await expect(page.locator('[data-component="session-budget-usage"]')).toContainText("1,200 / 30,000,000")
  await expect(page.locator('[data-component="session-budget-usage"]')).toContainText("1 / 720")
  await page.locator('[data-component="session-budget"] > summary').click()
  await expect(page.getByLabel("Total tokens", { exact: true })).toHaveValue("30000000")
  await expect(page.getByLabel("Total minutes", { exact: true })).toHaveValue("720")
  await page.getByLabel("Total tokens", { exact: true }).fill("40000000")
  const before = polls
  await expect.poll(() => polls).toBeGreaterThan(before)
  await expect(page.getByLabel("Total tokens", { exact: true })).toHaveValue("40000000")
  await page.screenshot({ path: info.outputPath("budget-usual.png") })
  await page.setViewportSize({ width: 900, height: 700 })
  await expect(page.getByRole("button", { name: "Apply limits and continue", exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath("budget-narrow.png") })
  await page.route(`**/api/session/${sessionID}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    const body = route.request().postDataJSON()
    tokens = body.budget.tokens
    durationMs = body.budget.durationMs
    await route.fulfill({ json: { data: {} } })
  })
  await page.getByRole("button", { name: "Remove limits and continue", exact: true }).click()
  await expect(page.locator('[data-component="session-budget-usage"]')).toContainText("No limit")
  await expect(page.getByLabel("Total tokens", { exact: true })).toHaveValue("")
})

test("S1 default settings save explicit unlimited and retain finite limits", async ({ page }, info) => {
  await setupTimeline(page, { settings: { newLayoutDesigns: true } })
  const bodies: unknown[] = []
  await page.route("**/global/config", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    bodies.push(route.request().postDataJSON())
    await route.fulfill({ json: route.request().postDataJSON() })
  })
  await page.keyboard.press("Control+,")
  const settings = page.locator('[data-component="settings-session-budget"]')
  await expect(settings).toBeVisible()
  await expect(settings.getByLabel("Total tokens", { exact: true })).toHaveValue("30000000")
  await expect(settings.getByLabel("Total minutes", { exact: true })).toHaveValue("720")
  await settings.screenshot({ path: info.outputPath("default-settings.png") })
  await settings.getByLabel("Total tokens", { exact: true }).fill("")
  await settings.getByLabel("Total minutes", { exact: true }).fill("")
  await settings.getByRole("button", { name: "Save default limits", exact: true }).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toEqual({ session_token_budget: null, session_duration_ms: null })
  await settings.getByLabel("Total tokens", { exact: true }).fill("40000000")
  await settings.getByLabel("Total minutes", { exact: true }).fill("1440")
  await settings.getByRole("button", { name: "Save default limits", exact: true }).click()
  await expect.poll(() => bodies.length).toBe(2)
  expect(bodies[1]).toEqual({ session_token_budget: 40000000, session_duration_ms: 86400000 })
})

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
