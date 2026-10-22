import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  userMessage,
  setupTimeline,
  status,
  partUpdated,
  textPart,
  messageUpdated,
  directory,
  sessionID,
  shell,
  userID,
  assistantID,
} from "./fixture"

for (const finish of ["stopped", "interrupted"])
  test(`S1 ${finish} settles without a success animation`, async ({ page }) => {
    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistantMessage([], { completed: false })],
      reducedMotion: false,
    })
    let running = true
    let stopped = false
    await page.route("**/api/session/active", (route) =>
      route.fulfill({ json: { data: running ? { [sessionID]: true } : {} } }),
    )
    // The S1 ownership watcher reconciles durable history after idle, so serve the same terminal fact there.
    await page.route(`**/api/session/${sessionID}/message?*`, async (route) => {
      if (!stopped) return route.fallback()
      await route.fulfill({
        json: {
          data: [
            {
              id: userID,
              type: "user",
              text: "Build the timeline stability matrix.",
              time: { created: 1700000000000 },
            },
            {
              id: "msg_1001_timeline_assistant",
              type: "assistant",
              agent: "build",
              model: { id: "claude-opus-4-6", providerID: "zaovra" },
              time: { created: 1700000001000, completed: 1700000002000 },
              finish,
              content: [{ id: "prt_terminal", type: "text", text: "Work remains" }],
            },
          ],
          cursor: {},
        },
      })
    })
    await timeline.send(status("busy"))
    await timeline.send(partUpdated(textPart("prt_terminal", "Work remains")))
    await expect(page.locator('[data-component="task-mascot"][data-state="thinking"]').first()).toBeVisible()
    const message = assistantMessage([textPart("prt_terminal", "Work remains")]).info
    await timeline.send(messageUpdated({ ...message, finish }))
    stopped = true
    running = false
    await timeline.send(status("idle"))
    // The settled thinking row is removed; stopped turns must not add a success mascot.
    await expect(page.locator('[data-component="task-mascot"][data-state="thinking"]')).toHaveCount(0)
    await expect(page.locator('[data-component="task-mascot"][data-state="success"]')).toHaveCount(0)
    await expect(
      page.getByText(finish === "stopped" ? "Stopped" : "Interrupted", { exact: true }).first(),
    ).toBeVisible()
  })

test("historical completed messages stay static after reload", async ({ page }) => {
  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_history", "Already finished")])],
    reducedMotion: false,
  })
  // V2 active is an ownership map, not V1's map of status objects (even idle objects are truthy).
  await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
  const mascots = page.locator('[data-component="task-mascot"]')
  await page.reload()
  await expect(mascots.first()).toHaveAttribute("data-state", "idle")
  await expect(mascots.first()).toHaveAttribute("data-motion", "paused")
  await expect(mascots.first()).toHaveAttribute("data-blink", "")
  expect(await mascots.first().evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0)
  await expect(page.locator('[data-component="task-mascot"]:not([data-state="idle"])')).toHaveCount(0)
})

test("mascot follows live events in one resident node, rests after completion, and respects reduced motion", async ({
  page,
}, info) => {
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([], { completed: false })],
    reducedMotion: false,
  })
  const mascot = page.locator(
    `[data-timeline-row="AssistantHeading"][data-message-id="${userID}"] [data-component="task-mascot"]`,
  )
  await timeline.send(status("busy"))
  await expect(mascot).toHaveCount(1)
  await expect(mascot).toHaveAttribute("data-motion", "running")
  const resident = await mascot.elementHandle()
  await expect(mascot.filter({ has: page.locator('[data-slot="mascot-dots"]') }).first()).toBeVisible()
  if (process.env.ZAOVRA_UI_SCREENSHOTS === "1") await page.screenshot({ path: info.outputPath("thinking.png") })
  await timeline.send(partUpdated(textPart("prt_mascot_text", "Working on the requested change")))
  await timeline.send(partUpdated(shell("prt_mascot_tool", "running", "", "npm test")))
  await expect(page.locator('[data-component="task-mascot"][data-state="working"]').first()).toBeVisible()
  if (process.env.ZAOVRA_UI_SCREENSHOTS === "1") await page.screenshot({ path: info.outputPath("working.png") })
  await timeline.transport.writeRaw(
    `data: ${JSON.stringify({ directory, payload: { id: "evt_mascot_permission", type: "permission.asked", properties: { id: "per_mascot", sessionID, permission: "bash", patterns: ["*"], always: [], metadata: {} } } })}\n\n`,
  )
  await expect(page.locator('[data-component="task-mascot"][data-state="awaiting"]').first()).toBeVisible()
  if (process.env.ZAOVRA_UI_SCREENSHOTS === "1") await page.screenshot({ path: info.outputPath("awaiting.png") })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(mascot).toHaveAttribute("data-motion", "paused")
  await expect(mascot).toHaveAttribute("data-blink", "")
  expect(await mascot.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0)
  await expect(mascot.locator('[data-slot="mascot-mark"]').first()).toHaveCSS("animation-name", "none")
  await expect(page.locator('[data-state="awaiting"] > img').first()).toHaveCSS("animation-name", "none")
  if (process.env.ZAOVRA_UI_SCREENSHOTS === "1") await page.screenshot({ path: info.outputPath("reduced-motion.png") })
  await timeline.transport.writeRaw(
    `data: ${JSON.stringify({ directory, payload: { id: "evt_mascot_replied", type: "permission.replied", properties: { sessionID, requestID: "per_mascot", reply: "once" } } })}\n\n`,
  )
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await expect(mascot).toHaveAttribute("data-motion", "running")
  await timeline.send(partUpdated(shell("prt_mascot_tool", "completed", "verified", "npm test")))
  await timeline.send(messageUpdated(assistantMessage([textPart("prt_mascot_text", "Done")]).info))
  await timeline.send(status("idle"))
  await expect(page.locator('[data-component="task-mascot"][data-state="success"]').first()).toBeVisible()
  expect(await mascot.evaluate((element, resident) => element === resident, resident)).toBe(true)
  await expect(mascot).toHaveCount(1)
  if (process.env.ZAOVRA_UI_SCREENSHOTS === "1") await page.screenshot({ path: info.outputPath("success.png") })
  await expect(page.locator('[data-component="task-mascot"][data-state="success"]')).toHaveCount(0)
  await expect(mascot.first()).toHaveAttribute("data-state", "idle")
  await expect(mascot).toHaveAttribute("data-motion", "paused")
  await expect(mascot).toHaveAttribute("data-blink", "")
  expect(await mascot.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0)
  await timeline.send(status("busy"))
  await timeline.send(
    messageUpdated(
      assistantMessage([textPart("prt_mascot_text", "Stopped")], {
        error: { name: "APIError", data: { message: "HTTP 500: upstream failure", isRetryable: false } },
      }).info,
    ),
  )
  await timeline.send(status("idle"))
  await expect(page.locator('[data-component="task-mascot"][data-state="error"]').first()).toBeVisible()
  await expect(page.locator('[data-component="execution-error-card"] [data-component="task-mascot"]')).toHaveCount(0)
  await expect(mascot).toHaveCount(1)
  expect(await mascot.evaluate((element, resident) => element === resident, resident)).toBe(true)
  if (process.env.ZAOVRA_UI_SCREENSHOTS === "1") await page.screenshot({ path: info.outputPath("error.png") })
  await timeline.send(status("busy"))
  await timeline.send(messageUpdated(assistantMessage([], { id: "msg_recovered", created: 1700000005000 }).info))
  await timeline.send(status("idle"))
  await expect(page.locator('[data-component="task-mascot"][data-state="success"]').first()).toBeVisible()
  expect(await mascot.evaluate((element, resident) => element === resident, resident)).toBe(true)
})

test("tool failure recovers on the same mascot when the next real operation starts", async ({ page }) => {
  const timeline = await setupTimeline(page, { messages: [userMessage(), assistantMessage([], { completed: false })] })
  const mascot = page.locator(
    `[data-timeline-row="AssistantHeading"][data-message-id="${userID}"] [data-component="task-mascot"]`,
  )
  await expect(mascot).toHaveCount(1)
  const resident = await mascot.elementHandle()
  await timeline.send(partUpdated(shell("prt_failure", "error", "", "npm test")))
  await expect(mascot).toHaveAttribute("data-state", "error")
  await timeline.send(partUpdated(shell("prt_retry", "running", "", "npm test")))
  await expect(mascot).toHaveAttribute("data-state", "working")
  await timeline.send(partUpdated(shell("prt_retry", "completed", "passed", "npm test")))
  await expect(mascot).toHaveAttribute("data-state", "thinking")
  expect(await mascot.evaluate((element, resident) => element === resident, resident)).toBe(true)
  await expect(mascot).toHaveCount(1)
})

test("error-only replies and synthetic continuation share one resident heading", async ({ page }) => {
  const continuation = "msg_1002_continuation"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([], { error: { name: "APIError", data: { message: "HTTP 500", isRetryable: false } } }),
      userMessage([{ type: "text", id: "prt_continuation", text: "Continue", synthetic: true }], { id: continuation }),
      assistantMessage([shell("prt_continued_tool", "completed", "done", "npm test")], {
        id: "msg_1003_answer",
        parentID: continuation,
      }),
    ],
  })
  // Legacy-shaped mock history has no V2 provider error; project that fact through its actual event adapter.
  const failed = assistantMessage([], {
    error: { name: "APIError", data: { message: "HTTP 500", isRetryable: false } },
  }).info
  await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
  await timeline.send(status("idle"))
  await timeline.send(messageUpdated(failed))
  await expect(page.locator('[data-timeline-row="AssistantHeading"]')).toHaveCount(1)
  await expect(page.locator('[data-component="task-mascot"]')).toHaveCount(1)
  await expect(page.locator('[data-component="execution-error-card"]')).toHaveCount(1)
  await expect(page.locator('[data-component="execution-error-card"] [data-component="task-mascot"]')).toHaveCount(0)
  await expect(page.getByRole("button", { name: /Took .*s/ })).toHaveCount(1)
})

for (const late of ["provider error", "tool error", "stopped"] as const)
  test(`late ${late} replaces completion on the same resident mascot`, async ({ page }) => {
    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistantMessage([], { completed: false })],
    })
    const mascot = page.locator(
      `[data-timeline-row="AssistantHeading"][data-message-id="${userID}"] [data-component="task-mascot"]`,
    )
    const resident = await mascot.elementHandle()
    await timeline.send(status("busy"))
    const completed = assistantMessage([textPart("prt_late_completion", "Completed projection")]).info
    await timeline.send(messageUpdated(completed))
    await timeline.send(status("idle"))
    await expect(mascot).toHaveAttribute("data-state", "success")
    if (late === "tool error") await timeline.send(partUpdated(shell("prt_late_failure", "error", "", "npm test")))
    if (late === "provider error")
      await timeline.send(
        messageUpdated({
          ...completed,
          error: { name: "APIError", data: { message: "HTTP 500: late failure", isRetryable: false } },
        }),
      )
    if (late === "stopped") await timeline.send(messageUpdated({ ...completed, finish: "stopped" }))
    await expect(mascot).toHaveAttribute("data-state", late === "stopped" ? "idle" : "error", { timeout: 1500 })
    await expect(page.locator('[data-component="task-mascot"][data-state="success"]')).toHaveCount(0)
    if (late === "provider error") await expect(page.locator('[data-component="execution-error-card"]')).toHaveCount(1)
    if (late === "stopped") await expect(page.getByText("Stopped", { exact: true })).toBeVisible()
    expect(await mascot.evaluate((element, resident) => element === resident, resident)).toBe(true)
  })

test("unrelated part updates after the five second terminal rest do not replay completion", async ({ page }) => {
  const timeline = await setupTimeline(page, { messages: [userMessage(), assistantMessage([], { completed: false })] })
  const mascot = page.locator(
    `[data-timeline-row="AssistantHeading"][data-message-id="${userID}"] [data-component="task-mascot"]`,
  )
  await timeline.send(status("busy"))
  const completed = assistantMessage([textPart("prt_no_replay", "Completed")]).info
  await timeline.send(messageUpdated(completed))
  await timeline.send(status("idle"))
  await expect(mascot).toHaveAttribute("data-state", "success")
  await expect(mascot).toHaveAttribute("data-state", "idle", { timeout: 6500 })
  const observed = await mascot.evaluateHandle((element) => {
    const events: string[] = []
    const observer = new MutationObserver(() => events.push(element.getAttribute("data-state") ?? ""))
    observer.observe(element, { attributes: true, attributeFilter: ["data-state"] })
    return { events, observer }
  })
  await timeline.send(
    partUpdated({ ...textPart("prt_unrelated", "Extra evidence"), sessionID, messageID: assistantID }),
  )
  await timeline.send(messageUpdated(completed))
  await timeline.settle(5)
  expect(
    await observed.evaluate(({ events, observer }) => {
      observer.disconnect()
      return events
    }),
  ).not.toContain("success")
  await expect(mascot).toHaveAttribute("data-state", "idle")
})
