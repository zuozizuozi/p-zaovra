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
} from "./fixture"

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
  await expect(page.locator('[data-component="task-mascot"]:not([data-state="idle"])')).toHaveCount(0)
})

test("mascot follows live events, rests after completion, and respects reduced motion", async ({ page }, info) => {
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([], { completed: false })],
    reducedMotion: false,
  })
  const mascot = page.locator('[data-component="task-mascot"]')
  await timeline.send(status("busy"))
  await expect(mascot.filter({ has: page.locator('[data-slot="mascot-dots"]') }).first()).toBeVisible()
  await page.screenshot({ path: info.outputPath("thinking.png") })
  await timeline.send(partUpdated(textPart("prt_mascot_text", "Working on the requested change")))
  await expect(page.locator('[data-component="task-mascot"][data-state="working"]').first()).toBeVisible()
  await page.screenshot({ path: info.outputPath("working.png") })
  await timeline.transport.writeRaw(
    `data: ${JSON.stringify({ directory, payload: { id: "evt_mascot_permission", type: "permission.asked", properties: { id: "per_mascot", sessionID, permission: "bash", patterns: ["*"], always: [], metadata: {} } } })}\n\n`,
  )
  await expect(page.locator('[data-component="task-mascot"][data-state="awaiting"]').first()).toBeVisible()
  await page.screenshot({ path: info.outputPath("awaiting.png") })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(page.locator('[data-state="awaiting"] > img').first()).toHaveCSS("animation-name", "none")
  await page.screenshot({ path: info.outputPath("reduced-motion.png") })
  await timeline.transport.writeRaw(
    `data: ${JSON.stringify({ directory, payload: { id: "evt_mascot_replied", type: "permission.replied", properties: { sessionID, requestID: "per_mascot", reply: "once" } } })}\n\n`,
  )
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await timeline.send(messageUpdated(assistantMessage([textPart("prt_mascot_text", "Done")]).info))
  await timeline.send(status("idle"))
  await expect(page.locator('[data-component="task-mascot"][data-state="success"]').first()).toBeVisible()
  await page.screenshot({ path: info.outputPath("success.png") })
  await expect(page.locator('[data-component="task-mascot"][data-state="success"]')).toHaveCount(0)
  await expect(mascot.first()).toHaveAttribute("data-state", "idle")
  await timeline.send(status("busy"))
  await timeline.send(
    messageUpdated(
      assistantMessage([textPart("prt_mascot_text", "Stopped")], {
        error: { name: "MessageAbortedError", data: { message: "Cancelled" } },
      }).info,
    ),
  )
  await timeline.send(status("idle"))
  await expect(page.locator('[data-component="task-mascot"][data-state="error"]').first()).toBeVisible()
  await page.screenshot({ path: info.outputPath("error.png") })
  await timeline.send(status("busy"))
  await timeline.send(messageUpdated(assistantMessage([], { id: "msg_recovered", created: 1700000005000 }).info))
  await timeline.send(status("idle"))
  await expect(page.locator('[data-component="task-mascot"][data-state="success"]').first()).toBeVisible()
})
