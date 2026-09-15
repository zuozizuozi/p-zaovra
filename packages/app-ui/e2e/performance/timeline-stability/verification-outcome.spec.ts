import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, status, textPart, userMessage } from "./fixture"

test("keeps host verification incomplete even when the assistant claims all tests passed", async ({ page }) => {
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_claim", "All tests passed. The game is complete.")])],
  })
  await page.route("**/session/*/outcome*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          state: "completed_unverified",
          outcomeUnknown: false,
          checks: [
            {
              kind: "syntax",
              command: "check-game",
              exit: 0,
              callID: "syntax",
              targets: [{ path: "C:/desktop/game.html", digest: "v1" }],
              logs: ["ev_test_evidence"],
            },
          ],
          missing: ["smoke: C:/desktop/game.html", "interaction: C:/desktop/game.html"],
        },
      }),
    }),
  )
  await timeline.send(status("idle"))
  await expect(page.getByText("All tests passed. The game is complete.", { exact: true })).toBeVisible()
  await expect(page.getByText("Finished — verification incomplete", { exact: true })).toBeVisible()
  await page.locator("summary").filter({ hasText: "Recorded checks" }).click()
  await expect(page.getByText("ev_test_evidence", { exact: true })).toBeVisible()
  await expect(page.getByText(/interaction: C:\/desktop\/game.html/)).toBeVisible()
})
