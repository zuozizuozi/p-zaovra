import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  directory,
  reasoningPart,
  sessionID,
  setupTimeline,
  textPart,
  userMessage,
  userText,
} from "./fixture"

test("routes prompt shortcuts to the current page through repeated draft transitions", async ({ page }) => {
  const warnings: string[] = []
  page.on("console", (message) => {
    if (message.text().includes("duplicate command id")) warnings.push(message.text())
  })
  await setupTimeline(page, { messages: [userMessage(), assistantMessage([textPart("prt_answer", "Done")])] })
  const sessionLink = page.locator(`a[href$="/session/${sessionID}"]`).last()
  for (let index = 0; index < 3; index++) {
    await page.getByRole("button", { name: "New session", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Start a new task", exact: true })).toBeVisible()
    await page.getByRole("heading", { name: "Start a new task", exact: true }).click()
    await page.keyboard.press("Control+l")
    await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeFocused()
    await page.keyboard.press("Control+k")
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.locator("[data-dialog-layer]")).toHaveCount(0)
    // DialogProvider retains its shortcut lock for a 100ms close transition.
    await page.waitForTimeout(120)
    await sessionLink.click()
    await expect(page.getByRole("heading", { name: "Start a new task", exact: true })).toHaveCount(0)
    await expect(page.getByText("Done", { exact: true })).toBeVisible()
    await page.getByText("Done", { exact: true }).click()
    await page.keyboard.press("Control+k")
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    await expect(page.locator("[data-dialog-layer]")).toHaveCount(0)
    await page.waitForTimeout(120)
    await page.getByText("Done", { exact: true }).click()
    await page.keyboard.press("Control+l")
    await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeFocused()
  }
  expect(warnings).toEqual([])
})

test("keeps the context panel visible when a live prompt has an ISO timestamp", async ({ page }) => {
  const fixture = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_answer", "Done")])],
  })
  await page.getByRole("button", { name: "View context usage", exact: true }).click()
  await expect(page.getByRole("tabpanel", { name: "Context", exact: true })).toBeVisible()
  await fixture.transport.writeRaw(
    `data: ${JSON.stringify({
      directory,
      payload: {
        type: "session.next.prompted",
        properties: {
          sessionID,
          messageID: "msg_2000_iso",
          timestamp: "2026-09-19T17:24:56.820Z",
          delivery: "steer",
          prompt: { text: "ISO continuation" },
        },
      },
    })}\n\n`,
  )
  await expect(page.getByRole("tabpanel", { name: "Context", exact: true })).toContainText("msg_2000_iso")
  await expect(page.getByText("Something went wrong", { exact: true })).toHaveCount(0)
})

test("shows the current reasoning heading and distinguishes host delivery review", async ({ page }) => {
  await setupTimeline(page, {
    messages: [
      userMessage([userText("Verification closing review: {}", { synthetic: true })]),
      assistantMessage([reasoningPart("prt_old", "## Old implementation")]),
      assistantMessage([reasoningPart("prt_current", "## Check delivered files")], {
        id: "msg_1002_current",
        completed: false,
      }),
    ],
  })
  const thinking = page.locator('[data-slot="session-turn-thinking"]')
  await expect(thinking).toContainText("Reviewing delivery and verification")
  await expect(thinking).toContainText("Check delivered files")
  await expect(thinking).not.toContainText("Old implementation")
})

for (const compacted of [false, true]) {
  test(`reports manual compaction result ${compacted}`, async ({ page }) => {
    await setupTimeline(page, { messages: [userMessage(), assistantMessage([textPart("prt_answer", "Done")])] })
    let calls = 0
    await page.route("**/session/*/compact", (route) => {
      calls++
      return route.fulfill({ json: { data: { compacted } } })
    })
    await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("/compact")
    await page.getByRole("button", { name: /^\/compact / }).click()
    await expect(
      page.getByText(compacted ? "Conversation compacted" : "Conversation was not compacted", { exact: true }),
    ).toBeVisible()
    expect(calls).toBe(1)
  })
}
