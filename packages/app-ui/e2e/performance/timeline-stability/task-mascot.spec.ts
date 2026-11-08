import { expect, test, type Locator } from "@playwright/test"
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

// The rig writes SVG attributes on animation frames, so a paused mascot is one whose subtree stops changing.
const attributeWrites = (mascot: Locator) =>
  mascot.evaluate(async (element) => {
    let writes = 0
    const observer = new MutationObserver((records) => (writes += records.length))
    observer.observe(element.querySelector("svg")!, { attributes: true, subtree: true })
    await new Promise((resolve) => setTimeout(resolve, 700))
    observer.disconnect()
    return writes
  })

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
  await page.reload()
  await expect(page.getByText("Already finished", { exact: true }).first()).toBeVisible()
  await expect(page.locator('[data-component="task-mascot"]')).toHaveCount(0)
})

test("mascot follows live events in one resident node, stops when paused, and leaves at completion", async ({
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
  await expect(mascot.locator('[data-badge="thinking"]')).toBeVisible()
  expect(await attributeWrites(mascot)).toBeGreaterThan(0)
  if (process.env.ZAOVRA_UI_SCREENSHOTS === "1") await page.screenshot({ path: info.outputPath("thinking.png") })
  await timeline.send(partUpdated(textPart("prt_mascot_text", "Working on the requested change")))
  await timeline.send(partUpdated(shell("prt_mascot_tool", "running", "", "npm test")))
  await expect(mascot).toHaveAttribute("data-state", "working")
  await expect(mascot).toHaveAttribute("data-pose", "processing")
  await expect(mascot.locator('[data-part="orbit-front"]')).toBeVisible()
  if (process.env.ZAOVRA_UI_SCREENSHOTS === "1") await page.screenshot({ path: info.outputPath("working.png") })
  await timeline.transport.writeRaw(
    `data: ${JSON.stringify({ directory, payload: { id: "evt_mascot_permission", type: "permission.asked", properties: { id: "per_mascot", sessionID, permission: "bash", patterns: ["npm test"], metadata: {}, always: [] } } })}\n\n`,
  )
  await expect(mascot).toHaveAttribute("data-state", "awaiting")
  await expect(mascot.locator('[data-badge="awaiting"]')).toBeVisible()
  if (process.env.ZAOVRA_UI_SCREENSHOTS === "1") await page.screenshot({ path: info.outputPath("awaiting.png") })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(mascot).toHaveAttribute("data-motion", "paused")
  await page.waitForTimeout(100)
  expect(await attributeWrites(mascot)).toBe(0)
  await expect(mascot.locator('[data-badge="awaiting"]')).toBeVisible()
  if (process.env.ZAOVRA_UI_SCREENSHOTS === "1") await page.screenshot({ path: info.outputPath("reduced-motion.png") })
  await timeline.transport.writeRaw(
    `data: ${JSON.stringify({ directory, payload: { id: "evt_mascot_replied", type: "permission.replied", properties: { sessionID, requestID: "per_mascot", reply: "once" } } })}\n\n`,
  )
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await expect(mascot).toHaveAttribute("data-motion", "running")
  expect(await mascot.evaluate((element, resident) => element === resident, resident)).toBe(true)
  await timeline.send(partUpdated(shell("prt_mascot_tool", "completed", "verified", "npm test")))
  await timeline.send(messageUpdated(assistantMessage([textPart("prt_mascot_text", "Done")]).info))
  await timeline.send(status("idle"))
  // The activity row belongs to a working turn; a settled turn shows its summary instead.
  await expect(mascot).toHaveCount(0)
  await expect(page.locator('[data-component="task-mascot"][data-state="success"]')).toHaveCount(0)
})

// Writing is a live fact: only deltas start it, and finished, superseded or resynced text must not keep it.
test("the writing pose follows the live text stream", async ({ page }) => {
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([], { completed: false })],
    reducedMotion: false,
  })
  const mascot = page.locator(
    `[data-timeline-row="AssistantHeading"][data-message-id="${userID}"] [data-component="task-mascot"]`,
  )
  const label = page.locator('[data-component="task-activity"] [data-slot="activity-label"]')
  let sequence = 0
  const v2 = (type: string, properties: Record<string, unknown>) =>
    timeline.transport.writeRaw(
      `data: ${JSON.stringify({ directory, payload: { id: `evt_writing_${sequence++}`, type: `session.next.${type}`, properties: { timestamp: 1700000002000, sessionID, assistantMessageID: assistantID, ...properties } } })}\n\n`,
    )
  const expectPose = async (pose: string) => {
    await expect(mascot).toHaveAttribute("data-pose", pose)
    await expect(mascot).toHaveAttribute("data-state", "thinking")
  }
  // Text end and step failure refetch history. This fixture's history has no live parts, so a landing refetch would
  // delete the part under test at a random moment; the real server returns it.
  await page.route(`**/api/session/${sessionID}/message?*`, (route) => route.abort())
  await timeline.send(status("busy"))
  await expectPose("thinking")
  await expect(label).toHaveText("Thinking")

  await v2("text.started", { textID: "txt_a" })
  await timeline.settle(5)
  await expectPose("thinking")
  await v2("text.delta", { textID: "txt_a", delta: "Hello" })
  await expectPose("speaking")
  await expect(label).toHaveText("Writing")
  await v2("text.ended", { textID: "txt_a", text: "Hello" })
  await expectPose("thinking")
  await expect(label).toHaveText("Thinking")

  await v2("text.started", { textID: "txt_b" })
  await v2("text.delta", { textID: "txt_b", delta: "More" })
  await expectPose("speaking")
  await v2("reasoning.started", { reasoningID: "rsn_c" })
  await expectPose("thinking")

  await v2("text.started", { textID: "txt_d" })
  await v2("text.delta", { textID: "txt_d", delta: "Again" })
  await expectPose("speaking")
  await timeline.transport.writeRaw(`data: ${JSON.stringify({ directory, payload: { type: "server.connected", properties: {} } })}\n\n`)
  await expectPose("thinking")

  await v2("text.started", { textID: "txt_e" })
  await v2("text.delta", { textID: "txt_e", delta: "Stepping" })
  await expectPose("speaking")
  await v2("step.ended", { finish: "tool-calls", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  await expectPose("thinking")

  await v2("text.ended", { textID: "txt_never_started", text: "Recovered terminal text" })
  await timeline.settle(5)
  await expectPose("thinking")

  await v2("text.started", { textID: "txt_f" })
  await v2("text.delta", { textID: "txt_f", delta: "Breaking" })
  await expectPose("speaking")
  await v2("step.failed", { error: { message: "stream broke" } })
  await expect(mascot).toHaveAttribute("data-pose", "error")
})

test("a completed snapshot ends the writing pose when the end event never arrives", async ({ page }) => {
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([], { completed: false })],
    reducedMotion: false,
  })
  const mascot = page.locator(
    `[data-timeline-row="AssistantHeading"][data-message-id="${userID}"] [data-component="task-mascot"]`,
  )
  const v2 = (id: string, type: string, properties: Record<string, unknown>) =>
    timeline.transport.writeRaw(
      `data: ${JSON.stringify({ directory, payload: { id, type: `session.next.${type}`, properties: { timestamp: 1700000002000, sessionID, assistantMessageID: assistantID, ...properties } } })}\n\n`,
    )
  await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: { [sessionID]: true } } }))
  await timeline.send(status("busy"))
  await v2("evt_snapshot_0", "text.started", { textID: "txt_snapshot" })
  await v2("evt_snapshot_1", "text.delta", { textID: "txt_snapshot", delta: "Hello" })
  await expect(mascot).toHaveAttribute("data-pose", "speaking")
  await page.route(`**/api/session/${sessionID}/message?*`, (route) =>
    route.fulfill({
      json: {
        data: [
          { id: userID, type: "user", text: "Build the timeline stability matrix.", time: { created: 1700000000000 } },
          {
            id: assistantID,
            type: "assistant",
            agent: "build",
            model: { id: "claude-opus-4-6", providerID: "zaovra" },
            time: { created: 1700000001000, completed: 1700000002000 },
            content: [{ id: "txt_snapshot", type: "text", text: "Hello" }],
          },
        ],
        cursor: {},
      },
    }),
  )
  // An offset gap makes the client refetch history, the same path a silent resync takes; no end event is sent.
  await v2("evt_snapshot_2", "text.delta", { textID: "txt_snapshot", delta: "!", offset: 99 })
  await expect(mascot).toHaveAttribute("data-pose", "thinking")
  await expect(mascot).toHaveAttribute("data-state", "thinking")
})

test("poking the mascot returns to the current pose's face", async ({ page }) => {
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([], { completed: false })],
    reducedMotion: false,
  })
  const mascot = page.locator('[data-component="task-activity"] [data-component="task-mascot"]')
  await timeline.send(status("busy"))
  await timeline.send(partUpdated(shell("prt_poke", "running", "", "npm test")))
  await expect(mascot).toHaveAttribute("data-pose", "processing")
  const happy = mascot.locator('[data-part="eye-L"] [data-shape="happy"]')
  const closed = mascot.locator('[data-part="eye-L"] [data-shape="closed"]')
  await expect(closed).toBeVisible()
  for (const presses of [1, 2]) {
    for (let press = 0; press < presses; press++) await mascot.click({ force: true })
    await expect(happy).toBeVisible()
    await expect(happy).toBeHidden({ timeout: 3000 })
    await expect(closed).toBeVisible()
    await page.waitForTimeout(1300)
    await expect(happy).toBeHidden()
  }
  await mascot.click({ force: true })
  await expect(happy).toBeVisible()
  // A pose change owns the face: the old poke must not restore over it.
  await timeline.send(partUpdated(shell("prt_poke", "completed", "ok", "npm test")))
  await expect(mascot).toHaveAttribute("data-pose", "thinking")
  await page.waitForTimeout(1300)
  await expect(happy).toBeVisible()
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
  await expect(page.locator('[data-component="task-mascot"]')).toHaveCount(0)
  await expect(page.locator('[data-component="execution-error-card"]')).toHaveCount(1)
  await expect(page.locator('[data-component="execution-error-card"] [data-component="task-mascot"]')).toHaveCount(0)
  await expect(page.getByRole("button", { name: /Took .*s/ })).toHaveCount(1)
})

for (const late of ["provider error", "tool error", "stopped"] as const)
  test(`late ${late} after completion never shows a success mascot`, async ({ page }) => {
    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistantMessage([], { completed: false })],
    })
    await timeline.send(status("busy"))
    const completed = assistantMessage([textPart("prt_late_completion", "Completed projection")]).info
    await timeline.send(messageUpdated(completed))
    await timeline.send(status("idle"))
    await expect(page.locator('[data-component="task-mascot"]')).toHaveCount(0)
    if (late === "tool error") await timeline.send(partUpdated(shell("prt_late_failure", "error", "", "npm test")))
    if (late === "provider error")
      await timeline.send(
        messageUpdated({
          ...completed,
          error: { name: "APIError", data: { message: "HTTP 500: late failure", isRetryable: false } },
        }),
      )
    if (late === "stopped") await timeline.send(messageUpdated({ ...completed, finish: "stopped" }))
    await timeline.settle(5)
    await expect(page.locator('[data-component="task-mascot"][data-state="success"]')).toHaveCount(0)
    if (late === "provider error") await expect(page.locator('[data-component="execution-error-card"]')).toHaveCount(1)
    if (late === "stopped") await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible()
  })

test("unrelated part updates after completion do not replay a success mascot", async ({ page }) => {
  const timeline = await setupTimeline(page, { messages: [userMessage(), assistantMessage([], { completed: false })] })
  await timeline.send(status("busy"))
  const completed = assistantMessage([textPart("prt_no_replay", "Completed")]).info
  await timeline.send(messageUpdated(completed))
  const observed = await page.evaluateHandle(() => {
    const state = { success: false, observer: undefined as MutationObserver | undefined }
    state.observer = new MutationObserver(() => {
      if (document.querySelector('[data-component="task-mascot"][data-state="success"]')) state.success = true
    })
    state.observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] })
    return state
  })
  await timeline.send(status("idle"))
  await timeline.send(
    partUpdated({ ...textPart("prt_unrelated", "Extra evidence"), sessionID, messageID: assistantID }),
  )
  await timeline.send(messageUpdated(completed))
  await timeline.settle(5)
  expect(
    await observed.evaluate((state) => {
      state.observer?.disconnect()
      return state.success
    }),
  ).toBe(false)
})
