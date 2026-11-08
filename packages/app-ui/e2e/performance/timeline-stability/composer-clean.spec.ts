import { expect, test, type Page } from "@playwright/test"
import { assistantMessage, messageUpdated, partUpdated, setupTimeline, shell, status, textPart, userMessage } from "./fixture"

// Above the input only cards that need an answer may appear; run status belongs in the conversation.
const removed = [
  "session-status-bar",
  "session-live-progress",
  "session-evidence-risk",
  "session-end-bar",
  "session-termination",
  "session-recovery-actions",
  "verification-panel",
]

const expectClean = async (page: Page) => {
  const dock = page.locator('[data-component="session-prompt-dock"]')
  await expect(dock).toBeVisible()
  for (const name of removed) await expect(page.locator(`[data-component="${name}"]`)).toHaveCount(0)
  await expect(dock.locator("label")).toHaveCount(0)
  await expect(dock).not.toContainText(/unverified|Interrupted|checks|Background task|Evidence/i)
}

test("the area above the input stays clean while running, after an interrupt and after completion", async ({ page }) => {
  const timeline = await setupTimeline(page, { messages: [userMessage(), assistantMessage([], { completed: false })] })
  const chip = page.locator('[data-component="followup-chip"]')

  await timeline.send(status("busy"))
  await timeline.send(partUpdated(shell("prt_clean", "running", "", "npm test")))
  await expectClean(page)
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute("aria-pressed", "false")
  await chip.click()
  await expect(chip).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator('[data-slot="prompt-model-control"]')).toBeVisible()

  await timeline.send(partUpdated(shell("prt_clean", "completed", "ok", "npm test")))
  await timeline.send(
    messageUpdated({ ...assistantMessage([textPart("prt_clean_text", "Partly done")]).info, finish: "interrupted" }),
  )
  await timeline.send(status("idle"))
  await expect(page.getByText("Interrupted", { exact: true }).first()).toBeVisible()
  await expectClean(page)
  await expect(chip).toHaveCount(0)

  await timeline.send(status("busy"))
  await timeline.send(messageUpdated(assistantMessage([textPart("prt_clean_text", "All done")]).info))
  await timeline.send(status("idle"))
  await expectClean(page)
  await expect(chip).toHaveCount(0)
})
