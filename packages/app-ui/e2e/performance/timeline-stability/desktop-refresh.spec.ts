import { expect, test } from "@playwright/test"
import { assistantMessage, messageUpdated, setupTimeline, shell, status, textPart, userMessage } from "./fixture"

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
    await expect(card.getByRole("button", { name: "Providers", exact: true })).toBeVisible()
    await card.locator("summary").click()
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
  await expect(page.getByRole("button", { name: "Shell npm test", exact: true })).toBeVisible()
  await toggle.click()
  await expect(page.getByRole("button", { name: "Shell npm test", exact: true })).toBeHidden()
  await expect(page.getByText("Delivered result", { exact: true })).toBeVisible()
})

test("completion arriving after idle still shows once for five seconds", async ({ page }, info) => {
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_finish", "Finishing")], { completed: false })],
  })
  await timeline.send(status("busy"))
  await timeline.send(status("idle"), 200)
  await timeline.send(messageUpdated(assistantMessage([textPart("prt_finish", "Finishing")]).info))
  const success = page.locator('[data-component="task-mascot"][data-state="success"]')
  await expect(success.first()).toBeVisible()
  await page.screenshot({ path: info.outputPath("delayed-completion.png") })
  await page.waitForTimeout(3500)
  await expect(success.first()).toBeVisible()
  await expect(success).toHaveCount(0, { timeout: 4000 })
  await timeline.send(messageUpdated(assistantMessage([textPart("prt_finish", "Finishing")]).info))
  await expect(success).toHaveCount(0)
})
