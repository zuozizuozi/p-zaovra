import { expect, test } from "@playwright/test"
import {
  assistantID,
  assistantMessage,
  messageUpdated,
  setupTimeline,
  shell,
  status,
  textPart,
  userMessage,
  userID,
} from "./fixture"

for (const [kind, detail] of Object.entries({
  auth: "HTTP 401: invalid API key",
  billing: "HTTP 402: insufficient balance",
  rateLimit: "HTTP 429: rate limit",
  upstreamInterrupted: "upstream_http2_stream_error",
  overloaded: "service_overloaded",
  protocol: "HTTP 500: not implemented /v1/responses",
  model: "HTTP 404: model_not_found",
  network: "ECONNRESET: network error",
})) {
  test(`error card keeps ${kind} details behind disclosure`, async ({ page }, info) => {
    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistantMessage([], { completed: false })],
    })
    await timeline.send(
      messageUpdated(
        assistantMessage([], {
          completed: false,
          error: { name: "APIError", data: { message: detail, isRetryable: false } },
        }).info,
      ),
    )
    const card = page.locator('[data-component="execution-error-card"]')
    await expect(card).toBeVisible()
    await expect(card.locator("pre")).toBeHidden()
    await expect(card.getByRole("button", { name: "Check model service", exact: true })).toBeHidden()
    await card.locator("summary").click()
    await expect(card.getByRole("button", { name: "Check model service", exact: true })).toBeVisible()
    await expect(card.locator("pre")).toHaveText(detail)
    await page.screenshot({ path: info.outputPath(`${kind}.png`) })
  })
}

test("completed work folds without hiding the delivered response", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        shell("prt_done", "completed", "verified", "npm test"),
        textPart("prt_result", "Delivered result"),
      ]),
    ],
  })
  await expect(page.getByText("Delivered result", { exact: true })).toBeVisible()
  const toggle = page.getByRole("button", { name: /Took .*s/ })
  await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
  await page.reload()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  const group = page.locator('[data-component="process-tool-group"]')
  await expect(group).toHaveCount(1)
  await group.locator(":scope > summary").click()
  await expect(group).toHaveAttribute("open", "")
  const command = page.locator(`[data-timeline-part-id="${assistantID}:prt_done"] [data-slot="collapsible-trigger"]`)
  await expect(command).toHaveCount(1)
  await expect(command).toBeVisible()
  await expect(command).toContainText("npm test")
  await toggle.click()
  await expect(
    page.locator(`[data-timeline-part-id="${assistantID}:prt_done"] [data-slot="collapsible-trigger"]`),
  ).toBeHidden()
  await expect(page.getByText("Delivered result", { exact: true })).toBeVisible()
})

test("completion arriving after idle settles without a success mascot", async ({ page }, info) => {
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_finish", "Finishing")], { completed: false })],
  })
  await timeline.send(status("busy"))
  await timeline.send(status("idle"), 200)
  await timeline.send(messageUpdated(assistantMessage([textPart("prt_finish", "Finishing")]).info))
  // The activity row belongs to a working turn, so a settled turn shows its summary and never a success mascot.
  const success = page.locator('[data-component="task-mascot"][data-state="success"]')
  await timeline.settle(5)
  await expect(success).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("delayed-completion.png") })
  await timeline.send(messageUpdated(assistantMessage([textPart("prt_finish", "Finishing")]).info))
  await timeline.settle(5)
  await expect(success).toHaveCount(0)
})

test("synthetic continuations share one disclosure and preserve final text", async ({ page }) => {
  await setupTimeline(page, {
    settings: { newLayoutDesigns: true },
    viewport: { width: 1800, height: 1000 },
    messages: [
      userMessage(),
      assistantMessage([shell("prt_first_tool", "completed", "first", "npm test")]),
      userMessage([{ type: "text", id: "prt_synthetic", text: "Continue verification", synthetic: true }], {
        id: "msg_1002_synthetic",
      }),
      assistantMessage(
        [shell("prt_second_tool", "completed", "second", "npm run build"), textPart("prt_final", "Final deliverable")],
        { id: "msg_1003_second", parentID: "msg_1002_synthetic" },
      ),
    ],
  })
  await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
  await page.reload()
  const heads = page.getByRole("button", { name: /Took .*s/ })
  await expect(heads).toHaveCount(1)
  await expect(page.locator('[data-slot="assistant-brand"]')).toHaveCount(0)
  await expect(page.getByText("Final deliverable", { exact: true })).toBeVisible()
  await heads.click()
  const group = page.locator('[data-component="process-tool-group"]')
  await expect(group).toHaveCount(1)
  await group.locator(":scope > summary").click()
  await expect(group).toHaveAttribute("open", "")
  const build = page.locator(
    '[data-timeline-part-id="msg_1003_second:prt_second_tool"] [data-slot="collapsible-trigger"]',
  )
  const test = page.locator(`[data-timeline-part-id="${assistantID}:prt_first_tool"] [data-slot="collapsible-trigger"]`)
  await expect(build).toHaveCount(1)
  await expect(build).toBeVisible()
  await expect(build).toContainText("npm run build")
  await expect(test).toHaveCount(1)
  await expect(test).toBeVisible()
  await expect(test).toContainText("npm test")
  const widths = await page
    .locator('[data-slot="session-turn-assistant-content"]')
    .evaluateAll((es) => es.map((e) => e.getBoundingClientRect().width))
  expect(Math.max(...widths)).toBeLessThanOrEqual(720)
})

test("empty checks remain absent and error recovery remains available beside its card", async ({ page }) => {
  const requests: unknown[] = []
  const timeline = await setupTimeline(page, {
    settings: { newLayoutDesigns: true },
    messages: [userMessage(), assistantMessage([], { completed: false })],
  })
  await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
  await page.route("**/api/session/*/recover**", async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({ json: { data: {} } })
  })
  await page.route("**/api/session/*/outcome**", (route) =>
    route.fulfill({
      json: {
        data: {
          state: "failed",
          messageID: assistantMessage([]).info.id,
          outcomeUnknown: false,
          checks: [],
          missing: [],
        },
      },
    }),
  )
  await timeline.send(
    messageUpdated(
      assistantMessage([], {
        completed: false,
        error: { name: "APIError", data: { message: "HTTP 401: invalid API key", isRetryable: false } },
      }).info,
    ),
  )
  await timeline.send(status("idle"))
  const card = page.locator('[data-component="execution-error-card"]')
  await expect(card).toBeVisible()
  await card.locator("summary").click()
  await expect(card.locator("pre")).toHaveText("HTTP 401: invalid API key")
  const retry = page
    .locator('[data-component="session-recovery-actions"]')
    .getByRole("button", { name: "Retry", exact: true })
  await expect(retry).toHaveCount(1)
  await expect(retry).toBeVisible()
  await expect(page.locator('[data-component="verification-summary"]')).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Refresh verification status", exact: true })).toHaveCount(0)
  await retry.click()
  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toMatchObject({ messageID: assistantMessage([]).info.id, action: "retry" })
})
