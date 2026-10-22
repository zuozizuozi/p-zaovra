import { expect, test } from "@playwright/test"
import {
  assistantID,
  sessionID,
  assistantMessage,
  completedAssistantInfo,
  messageUpdated,
  partUpdated,
  reasoningPart,
  setupTimeline,
  shell,
  status,
  textPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

for (const expanded of [false, true]) {
  test(`preserves shell user intent from a ${expanded ? "expanded" : "collapsed"} default`, async ({ page }) => {
    const id = `prt_shell_default_${expanded}`
    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistantMessage([shell(id, "completed", lines(3))])],
      settings: { shellToolPartsExpanded: expanded },
      v2ToolUpdates: true,
    })
    const trigger = page.locator(`[data-timeline-part-id="${assistantID}:${id}"] [data-slot="collapsible-trigger"]`)
    await expect(trigger).toHaveAttribute("aria-expanded", String(expanded))
    await trigger.click()
    await expect(trigger).toHaveAttribute("aria-expanded", String(!expanded))

    await timeline.send(partUpdated(shell(id, "completed", lines(6))), 180)
    await timeline.transport.send(partUpdated(textPart(`prt_sibling_${expanded}`, "Sibling content")))
    await timeline.send(status("busy"), 100)
    await timeline.send(status("idle"), 250)
    const turn = page.locator('[data-timeline-row="AssistantHeading"] button[aria-expanded]')
    await expect(turn).toHaveAttribute("aria-expanded", "false")
    await turn.click()
    await expect(turn).toHaveAttribute("aria-expanded", "true")
    await expect(trigger).toHaveAttribute("aria-expanded", String(!expanded))
  })
}

test("transitions thinking and hidden reasoning through busy to idle", async ({ page }) => {
  const reasoningID = "prt_reasoning_hidden"
  const assistant = assistantMessage([reasoningPart(reasoningID, "## Inspecting stability")], { completed: false })
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistant],
    settings: { showReasoningSummaries: false },
    cpuRate: 4,
  })
  await timeline.send(status("busy"), 150)

  await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
  await expect(page.getByText("Inspecting stability", { exact: true })).toBeVisible()
  await expect(page.locator(`[data-timeline-part-id="${assistantID}:${reasoningID}"]`)).toHaveCount(0)
  await timeline.send(partUpdated(shell("prt_reasoning_shell", "running")), 160)
  await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
  await timeline.send(partUpdated(shell("prt_reasoning_shell", "completed", "done")), 180)
  await timeline.send(messageUpdated(completedAssistantInfo(assistant.info)), 100)
  await timeline.send(status("idle"), 300)
  await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(page.locator(`[data-timeline-part-id="${assistantID}:${reasoningID}"]`)).toHaveCount(0)
})

test("moves busy through retry and recovery to final idle content", async ({ page }) => {
  const assistant = assistantMessage([], { completed: false })
  const user = userMessage(undefined, {
    summary: {
      diffs: [
        {
          file: "src/retry.ts",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-export const retry = false\n+export const retry = true",
        },
      ],
    },
  })
  const timeline = await setupTimeline(page, {
    messages: [user, assistant],
  })
  let diffRequests = 0
  await page.route(`**/api/session/${sessionID}/message/${user.info.id}/diff*`, (route) => {
    diffRequests++
    return route.fulfill({
      json: { data: user.info.summary!.diffs.map((diff) => ({ ...diff, path: diff.file })) },
    })
  })
  await timeline.send(status("busy"), 140)
  await expect(page.locator('[data-timeline-row="AssistantHeading"] [data-component="task-activity"]')).toHaveAttribute(
    "data-state",
    "thinking",
  )
  await expect(page.locator('[data-timeline-row="DiffSummary"]')).toHaveCount(0)
  await timeline.send(status("retry"), 180)
  await expect(page.locator('[data-timeline-row="Retry"]')).toBeVisible()
  await expect(page.locator('[data-timeline-row="AssistantHeading"] [data-component="task-mascot"]')).toHaveCount(1)
  await timeline.send(status("busy", 2), 180)
  await expect(page.locator('[data-timeline-row="AssistantHeading"] [data-component="task-activity"]')).toHaveAttribute(
    "data-state",
    "thinking",
  )
  await timeline.send(partUpdated(textPart("prt_recovered", "Recovered response")), 140)
  await timeline.send(messageUpdated(completedAssistantInfo(assistant.info)), 100)
  await timeline.send(status("idle"), 350)
  await expect(page.locator('[data-timeline-row="Retry"]')).toHaveCount(0)
  await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(page.locator('[data-timeline-row="DiffSummary"]')).toBeVisible()
  await expect(page.locator('[data-timeline-row="DiffSummary"]')).toContainText("retry.ts")
  expect(diffRequests).toBeGreaterThan(0)
})

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}
