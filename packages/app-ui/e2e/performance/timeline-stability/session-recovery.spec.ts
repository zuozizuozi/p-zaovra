import { expect, test, type Page } from "@playwright/test"
import { assistantMessage, assistantID, session, sessionID, setupTimeline, textPart, userMessage } from "./fixture"

const errors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const items: string[] = []
  errors.set(page, items)
  page.on("pageerror", (error) => items.push(error.message))
})
test.afterEach(({ page }) => {
  expect(errors.get(page)).toEqual([])
})

async function stopped(
  page: Page,
  options: {
    failed?: boolean
    budgetFailure?: boolean
    locale?: string
    seedHistory?: boolean
    budget?: {
      limits: { tokens?: number; durationMs?: number }
      used: { tokens: number; durationMs: number }
      unreported: number
    }
  } = {},
) {
  const assistant = assistantMessage([textPart("prt_retained", "Retained partial work")])
  await setupTimeline(page, {
    locale: options.locale,
    seedHistory: options.seedHistory,
    messages: [
      userMessage(),
      { ...assistant, info: { ...assistant.info, finish: options.failed ? "error" : "stopped" } },
    ],
    sessions: [session(), { ...session(), id: "ses_recovery_other", title: "Another session" }],
  })
  const calls: { method: string; body: unknown }[] = []
  await page.route(`**/api/session/${sessionID}/outcome*`, (route) =>
    route.fulfill({
      json: {
        data: {
          state: options.failed ? "failed" : "stopped",
          messageID: assistantID,
          termination: { category: options.failed ? "network" : "budget", message: "Fixture stop" },
          outcomeUnknown: false,
          checks: [],
          missing: [],
        },
      },
    }),
  )
  await page.route(`**/api/session/${sessionID}/budget*`, (route) =>
    options.budgetFailure
      ? route.fulfill({ status: 503, json: { error: "Fixture budget unavailable" } })
      : route.fulfill({
          json: {
            data: options.budget ?? {
              limits: { tokens: 1000, durationMs: 60000 },
              used: { tokens: 1000, durationMs: 60000 },
              unreported: 0,
            },
          },
        }),
  )
  await page.route(`**/api/session/${sessionID}*`, (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    calls.push({ method: "PATCH", body: route.request().postDataJSON() })
    return route.fulfill({ json: { data: {} } })
  })
  await page.route(`**/api/session/${sessionID}/recover*`, (route) => {
    calls.push({ method: "recover", body: route.request().postDataJSON() })
    return route.fulfill({ json: { data: {} } })
  })
  await page.reload()
  return { calls, card: page.locator('[data-component="session-budget-recovery"]') }
}

test("budget recovery lives in the conversation, validates limits and updates before continuing once", async ({
  page,
}, info) => {
  const { calls, card } = await stopped(page)
  await expect(card).toBeVisible()
  await expect(page.locator('[data-component="session-prompt-dock"] [data-component="session-recovery"]')).toHaveCount(
    0,
  )
  await expect(
    page.locator(
      '[data-component="session-outcome-dock"], [data-component="session-end-bar"], [data-component="verification-panel"]',
    ),
  ).toHaveCount(0)
  await expect(page.getByText("Retained partial work", { exact: true }).first()).toBeVisible()
  await card.getByLabel("Total tokens", { exact: true }).fill("1000")
  await card.getByRole("button", { name: "Increase budget and continue", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Raise at least one limit")
  expect(calls).toEqual([])
  await card.getByLabel("Total tokens", { exact: true }).fill("2000")
  await card.getByLabel("Total minutes", { exact: true }).fill("5")
  await card.screenshot({ path: info.outputPath("budget-card-en.png") })
  await card.getByRole("button", { name: "Increase budget and continue", exact: true }).dblclick()
  await expect.poll(() => calls.length).toBe(2)
  expect(calls).toEqual([
    { method: "PATCH", body: { budget: { tokens: 2000, durationMs: 300000 } } },
    { method: "recover", body: { messageID: assistantID, action: "continue" } },
  ])
  await expect(card.getByRole("button", { name: "Continue requested", exact: true })).toBeDisabled()
})

test("budget PATCH failure remains actionable and never continues", async ({ page }) => {
  const { card } = await stopped(page)
  let recoveries = 0
  await page.route(`**/api/session/${sessionID}/recover*`, async (route) => {
    recoveries++
    await route.fulfill({ json: { data: {} } })
  })
  await page.route(`**/api/session/${sessionID}*`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 503, json: { error: "Fixture update failed" } })
      : route.fallback(),
  )
  await card.getByRole("button", { name: "Increase budget and continue", exact: true }).click()
  await expect(page.locator('[data-component="session-recovery"] [role="alert"]')).toBeVisible()
  await expect(card.getByRole("button", { name: "Increase budget and continue", exact: true })).toBeEnabled()
  expect(recoveries).toBe(0)
})

test("switching session during budget PATCH never continues either session", async ({ page }) => {
  const { card, calls } = await stopped(page)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await page.route(`**/api/session/${sessionID}*`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    started.resolve()
    await release.promise
    await route.fulfill({ json: { data: {} } })
  })
  await card.getByRole("button", { name: "Increase budget and continue", exact: true }).click()
  await started.promise
  await page.evaluate(() => {
    const link = document.createElement("a")
    link.href = location.pathname.replace("ses_timeline_stability", "ses_recovery_other")
    document.body.append(link)
    link.click()
    link.remove()
  })
  await expect(page).toHaveURL(/ses_recovery_other/)
  release.resolve()
  await expect(page.getByText("Budget updated; session was not continued.", { exact: true })).toBeVisible()
  expect(calls).toEqual([])
})

test("failed run offers explicit continue without changing any budget", async ({ page }) => {
  const { calls, card } = await stopped(page, { failed: true })
  await expect(card).toHaveCount(0)
  await page
    .locator('[data-component="session-recovery"]')
    .getByRole("button", { name: "Continue", exact: true })
    .click()
  await expect.poll(() => calls.length).toBe(1)
  expect(calls[0]).toEqual({ method: "recover", body: { messageID: assistantID, action: "continue" } })
})

test("unavailable budget never offers a blind continue", async ({ page }) => {
  const { calls, card } = await stopped(page, { budgetFailure: true })
  await expect(card.getByRole("alert")).toContainText("Could not load")
  await expect(card.getByRole("button", { name: "Increase budget and continue", exact: true })).toHaveCount(0)
  expect(calls).toEqual([])
})

test("Chinese budget card stays readable in the conversation", async ({ page }, info) => {
  const { card } = await stopped(page, { locale: "zh" })
  await expect(card.getByRole("button", { name: "提高预算并继续", exact: true })).toBeVisible()
  await expect(page.getByText("已达到会话预算，任务已停止。", { exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath("budget-card-zh.png"), fullPage: true })
})

test("raising a token-only budget preserves the unlimited duration axis", async ({ page }) => {
  const { calls, card } = await stopped(page, {
    budget: {
      limits: { tokens: 1000 },
      used: { tokens: 1000, durationMs: 5000 },
      unreported: 0,
    },
  })
  await expect(card.getByLabel("Total minutes", { exact: true })).toHaveValue("")
  await card.getByRole("button", { name: "Increase budget and continue", exact: true }).click()
  await expect.poll(() => calls.length).toBe(2)
  expect(calls[0]).toEqual({ method: "PATCH", body: { budget: { tokens: 1250 } } })
})

test("a failed continue can be retried explicitly", async ({ page }) => {
  const { calls } = await stopped(page, { failed: true })
  let rejected = true
  await page.route(`**/api/session/${sessionID}/recover*`, async (route) => {
    if (!rejected) return route.fallback()
    rejected = false
    await route.fulfill({ status: 409, json: { error: "Fixture recovery conflict" } })
  })
  const button = page
    .locator('[data-component="session-recovery"]')
    .getByRole("button", { name: "Continue", exact: true })
  await button.click()
  await expect(page.locator('[data-component="session-recovery"] [role="alert"]')).toBeVisible()
  await button.click()
  await expect.poll(() => calls.length).toBe(1)
})

test("pending recovery queries keep the virtual timeline and composer connected", async ({ page }) => {
  await stopped(page, { failed: true, seedHistory: true })
  await page.route(`**/api/session/${sessionID}/outcome*`, (route) =>
    route.fulfill({ status: 503, json: { error: "Fixture outcome unavailable" } }),
  )
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click()
  const recovery = page.locator('[data-component="session-recovery"]')
  const retry = recovery.getByRole("button", { name: "common.retry", exact: true })
  await expect(retry).toBeVisible()
  const editor = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await editor.fill("Keep this draft through the recovery request")
  const editorNode = await editor.elementHandle()
  const viewportNode = await page.locator('[data-component="session-panel"] .scroll-view__viewport').elementHandle()
  expect(editorNode).not.toBeNull()
  expect(viewportNode).not.toBeNull()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  await page.route(`**/api/session/${sessionID}/outcome*`, async (route) => {
    started.resolve()
    await release.promise
    await route.fulfill({
      json: {
        data: {
          state: "failed",
          messageID: assistantID,
          termination: { category: "network", message: "Fixture 429" },
          outcomeUnknown: false,
          checks: [],
          missing: [],
        },
      },
    })
  })
  try {
    await retry.click()
    await started.promise
    await expect(editor).toBeVisible()
    expect(await editorNode!.evaluate((node) => node.isConnected)).toBe(true)
    expect(await viewportNode!.evaluate((node) => node.isConnected)).toBe(true)
    await editor.fill("Typing remains available while recovery is pending")
    await expect(editor).toHaveText("Typing remains available while recovery is pending")
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
  } finally {
    release.resolve()
  }
  await expect(recovery.getByRole("button", { name: "Continue", exact: true })).toBeEnabled()
  await expect(editor).toHaveText("Typing remains available while recovery is pending")
  expect(await editorNode!.evaluate((node) => node.isConnected)).toBe(true)
  expect(await viewportNode!.evaluate((node) => node.isConnected)).toBe(true)
})
