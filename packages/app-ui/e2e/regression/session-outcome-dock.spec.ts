import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  directory,
  sessionID,
  setupTimeline,
  toolPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

for (const scenario of ["task", "preview", "unknown", "disconnect"] as const) {
  test(`live progress consumes connection-local shell evidence: ${scenario}`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    const jobID = `job_dock_${scenario}`
    const timeline = await setupTimeline(page, {
      locale: "en",
      settings: { newLayoutDesigns: true },
      messages: [
        userMessage(),
        assistantMessage([
          toolPart(
            `prt_dock_${scenario}`,
            "bash",
            "completed",
            { command: "echo fixture", background: true, background_kind: scenario === "preview" ? "preview" : "task" },
            { metadata: { job_id: jobID }, output: "Started fixture job" },
          ),
        ]),
      ],
    })
    // V2 active reports execution ownership; an idle V1 status object is truthy.
    await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
    await page.reload()
    await timeline.transport.waitForConnection()
    const send = (type: string, properties: Record<string, unknown>) =>
      timeline.transport.writeRaw(`data: ${JSON.stringify({ directory, payload: { type, properties } })}\n\n`)
    await send("server.connected", {})
    const progress = page.locator('[data-component="session-live-progress"]')
    await expect(progress).toBeVisible()
    await expect(progress.locator(":scope > p").first()).toContainText("Background job status unverified")
    await expect(progress).not.toContainText("Evidence updating")
    if (scenario !== "unknown") {
      await send("session.next.shell.started", {
        sessionID,
        messageID: jobID,
        callID: jobID,
        command: "echo fixture",
        timestamp: 1700000003000,
      })
      await expect(progress.locator(":scope > p").first()).toContainText(
        scenario === "preview" ? "Preview service running" : "Waiting for tool or background task results",
      )
      if (scenario === "preview") await expect(progress).not.toContainText("Evidence updating")
      else await expect(progress).toContainText("Evidence updating · remaining checks not yet confirmed")
    }
    if (scenario === "disconnect") {
      const first = await timeline.transport.waitForConnection()
      await timeline.transport.close()
      await expect(progress.locator(":scope > p").first()).toContainText(
        "Connection interrupted · execution status unverified",
      )
      await expect(progress).not.toContainText("Evidence updating")
      await expect(progress).not.toContainText("Waiting for tool or background task results")
      await timeline.transport.waitForConnection({ after: first.id })
      await send("server.connected", {})
      await expect(progress.locator(":scope > p").first()).toContainText("Background job status unverified")
      await expect(progress).not.toContainText("Evidence updating")
    }
    await testInfo.attach("browser-errors", { body: JSON.stringify(errors), contentType: "application/json" })
    expect(errors.filter((error) => !error.includes("ResizeObserver loop"))).toEqual([])
  })
}

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
  await expect(summary).toContainText("Latest checks: 1 passed")
  await summary.click()
  await page.locator('[data-component="verification-details"] > summary').click()
  await page.locator('[data-component="verification-explanation"] > summary').click()
  await expect(page.locator('[data-component="verification-details"] > summary')).toHaveText(
    "1 earlier failure records remain unresolved",
  )
  await expect(page.locator('[data-component="verification-explanation"]')).toContainText(
    "3 checks did not produce a valid result",
  )
  const history = page.locator('[data-component="verification-history"]')
  await expect(history).not.toHaveAttribute("open", "")
  await expect(history.locator(".text-icon-critical-base")).toHaveCount(0)
  const current = page.locator('[data-component="verification-current"]')
  await expect(current.locator(":scope > details")).toHaveCount(4)
  await expect(current.locator(":scope > details.text-icon-critical-base")).toHaveCount(3)
  const unresolved = page.locator('[data-component="verification-unresolved"]')
  await expect(unresolved.locator(":scope > details")).toHaveCount(1)
  await expect(unresolved.locator(":scope > details.text-icon-critical-base")).toHaveCount(1)
  const passed = current.locator(":scope > details").first()
  await expect(passed.locator("pre")).not.toBeVisible()
  await expect(passed.getByText("ev_private_detail", { exact: true })).not.toBeVisible()
  expect(await passed.locator("summary .truncate").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await passed.locator(":scope > summary").click()
  await expect(passed.locator("pre")).toHaveText(command)
  await expect(passed.getByText("ev_private_detail", { exact: true })).toBeHidden()
  await passed.locator("details > summary").click()
  await expect(passed.getByText("ev_private_detail", { exact: true })).toBeVisible()
  await history.locator(":scope > summary").click()
  await history.locator(":scope > details > summary").click()
  await history.locator("details details > summary").click()
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
  await expect(page.locator('[data-component="verification-summary"]')).toHaveText("Finished · No current checks")
  await page.locator('[data-component="verification-summary"]').click()
  await page.locator('[data-component="verification-details"] > summary').click()
  await page.locator('[data-component="verification-explanation"] > summary').click()
  await expect(page.getByText("Requirement coverage has not been recorded", { exact: false })).toBeVisible()
  await expect(
    page
      .locator('[role="status"]')
      .filter({ has: page.locator('[data-component="verification-summary"]') })
      .locator('[role="alert"]'),
  ).toHaveCount(1)
  await expect(page.locator('[data-component="verification-history"]')).toHaveCount(0)
})

for (const scenario of [
  { name: "QA dependency changed", missing: ["stale: build (build-1)"], exit: 0, passed: 1, stale: 1, failed: 0 },
  { name: "build failed", missing: [], exit: 1, passed: 1, stale: 0, failed: 1 },
  { name: "unchanged evidence", missing: [], exit: 0, passed: 2, stale: 0, failed: 0 },
]) {
  test(`current check counts: ${scenario.name}`, async ({ page }) => {
    await setupTimeline(page, { locale: "en", settings: { newLayoutDesigns: true } })
    await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
    await page.route("**/api/session/*/outcome**", (route) =>
      route.fulfill({
        json: {
          data: {
            state: "completed",
            outcomeUnknown: false,
            missing: scenario.missing,
            checks: [
              { kind: "build", command: "npm run build", callID: "build-1", exit: scenario.exit },
              { kind: "interaction", command: "node qa.mjs", callID: "interaction-1", exit: 0 },
            ],
          },
        },
      }),
    )
    await page.reload()
    const summary = page.locator('[data-component="verification-summary"]')
    await expect(summary).toContainText(`Latest checks: ${scenario.passed} passed`)
    await summary.click()
    await page.locator('[data-component="verification-details"] > summary').click()
    await page.locator('[data-component="verification-explanation"] > summary').click()
    const explanation = page.locator('[data-component="verification-explanation"]')
    if (scenario.stale) {
      await expect(explanation).toContainText("1 checks expired")
      await expect(summary).not.toContainText("\uFFFD")
      await expect(
        page.getByText("Dependencies changed. Refresh verification status or run the check again.", { exact: true }),
      ).toBeVisible()
      await expect(page.getByText("stale: build (build-1)", { exact: false })).toBeVisible()
    } else await expect(explanation).not.toContainText("checks expired")
    if (scenario.failed) {
      const unresolved = page.locator('[data-component="verification-unresolved"]')
      await expect(unresolved.locator(":scope > details")).toHaveCount(1)
      await expect(unresolved).toContainText("npm run build")
      await expect(unresolved).toContainText("exit 1")
    }
  })
}

test("failed execution keeps retry and more actions without empty verification", async ({ page }) => {
  await setupTimeline(page, { locale: "en", settings: { newLayoutDesigns: true } })
  await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
  await page.route("**/api/session/*/outcome**", (route) =>
    route.fulfill({
      json: {
        data: { state: "failed", messageID: "msg_original", outcomeUnknown: true, checks: [], missing: [] },
      },
    }),
  )
  const requests: { url: string; body: unknown }[] = []
  await page.route("**/api/session/*/recover**", async (route) => {
    requests.push({ url: route.request().url(), body: route.request().postDataJSON() })
    await route.fulfill({ json: { data: {} } })
  })
  await page.reload()
  const dock = page
    .locator('[role="status"]')
    .filter({ has: page.getByRole("button", { name: "Inspect and continue", exact: true }) })
  await expect(dock).toBeVisible()
  await expect(dock.getByRole("alert")).toBeVisible()
  await expect(page.locator('[data-component="verification-summary"]')).toHaveCount(0)
  await expect(dock.getByText("No current checks", { exact: true })).toHaveCount(0)
  await dock.getByRole("button", { name: "More options", exact: true }).click()
  await expect(page.getByRole("menuitem", { name: "Retry original request", exact: true })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Abandon and archive", exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  expect(requests).toEqual([])
  await dock.getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Retry original request", exact: true }).click()
  await expect.poll(() => requests.length).toBe(1)
  expect(new URL(requests[0]!.url).pathname).toBe(`/api/session/${sessionID}/recover`)
  expect(requests[0]!.body).toMatchObject({ messageID: "msg_original", action: "retry" })
})
