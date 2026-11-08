import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  assistantID,
  messageUpdated,
  sessionID,
  setupTimeline,
  status,
  textPart,
  userID,
  userMessage,
} from "./fixture"

for (const layout of [true, false])
  for (const order of ["receipt-first", "terminal-first", "no-assistant", "partial"] as const)
    test(`Stop before output keeps one visible confirmation: layout=${layout}, ${order}`, async ({ page }, info) => {
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      const partial = order === "partial"
      const initial = assistantMessage(partial ? [textPart("prt_retained_stop", "Retained work")] : [], {
        completed: false,
      })
      const timeline = await setupTimeline(page, {
        settings: { newLayoutDesigns: layout },
        messages: order === "no-assistant" ? [userMessage()] : [userMessage(), initial],
      })
      let running = true
      let terminal = false
      const wire = () => [
        { id: userID, type: "user", text: "Build the timeline stability matrix.", time: { created: 1700000000000 } },
        ...(order === "no-assistant"
          ? []
          : [
              {
                id: assistantID,
                type: "assistant",
                agent: "build",
                model: { id: "claude-opus-4-6", providerID: "zaovra" },
                time: { created: 1700000001000, ...(terminal ? { completed: 1700000002000 } : {}) },
                ...(terminal ? { finish: "interrupted" } : {}),
                content: partial ? [{ id: "prt_retained_stop", type: "text", text: "Retained work" }] : [],
              },
            ]),
      ]
      await page.route("**/api/session/active*", (route) =>
        route.fulfill({ json: { data: running ? { [sessionID]: true } : {} } }),
      )
      await page.route(`**/api/session/${sessionID}/message?*`, (route) =>
        route.fulfill({ json: { data: wire(), cursor: {} } }),
      )
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let interrupts = 0
      await page.route(`**/api/session/${sessionID}/interrupt*`, async (route) => {
        interrupts++
        started.resolve()
        await release.promise
        running = false
        await route.fulfill({ json: {} })
      })
      await timeline.send(status("busy"))
      await page.getByRole("button", { name: "Stop", exact: true }).click()
      await started.promise
      const finish = async () => {
        terminal = true
        if (order !== "no-assistant")
          await timeline.send(
            messageUpdated({
              ...initial.info,
              finish: "interrupted",
              time: { ...initial.info.time, completed: 1700000002000 },
            }),
          )
        await timeline.send(status("idle"))
      }
      if (order === "terminal-first") await finish()
      release.resolve()
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
      if (order !== "terminal-first") await finish()
      const feedback = page
        .locator('[data-slot="turn-terminal-status"], [data-timeline-row="TurnDivider"]')
        .filter({ hasText: /Stopped|Interrupted/ })
      await expect(feedback).toHaveCount(1)
      await expect(feedback).toBeVisible()
      await expect(page.locator('[data-component="session-prompt-dock"]')).not.toContainText(/Stopped|Interrupted/)
      if (partial) await expect(page.getByText("Retained work", { exact: true }).first()).toBeVisible()
      expect(interrupts).toBe(1)
      expect(errors).toEqual([])
      if (layout && order === "receipt-first")
        await page.screenshot({ path: info.outputPath("early-stop.png"), fullPage: true })
    })
