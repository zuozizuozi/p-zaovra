import { expect, test } from "@playwright/test"
import { setupTimelineBenchmark } from "./session-timeline-benchmark.fixture"

test("does not label the active first response as waiting to join another task", async ({ page }) => {
  await setupTimelineBenchmark(page, {
    historyTurns: 0,
    eventBatch: 1,
    newLayoutDesigns: true,
    awaitingProvider: true,
  })
  await expect(page.locator('[data-slot="session-turn-thinking"]')).toBeVisible()
  await expect(page.getByText("Waiting to join the current task…", { exact: true })).toHaveCount(0)
})

test("shows provider retry progress without replacing the conversation", async ({ page }) => {
  const fixture = await setupTimelineBenchmark(page, { historyTurns: 2, eventBatch: 1, newLayoutDesigns: true })
  const sessionID = "ses_timeline_state_regression"
  const directory = "C:/Zaovra/TimelineStateRegression"
  // The production wait endpoint holds while the drain owns this session.
  // Keep that contract instead of the fixture's immediate idle response.
  await page.route("**/api/session/*/wait", async (route) => {
    await new Promise<void>((resolve) => page.once("close", resolve))
    await route.abort().catch(() => {})
  })
  fixture.transport.enqueue({
    directory,
    payload: {
      type: "session.next.retried",
      properties: {
        sessionID,
        timestamp: Date.now(),
        attempt: 2,
        error: { message: "Provider retry diagnostic", isRetryable: true, metadata: { delayMs: "2000" } },
      },
    },
  })
  await expect(page.locator('[data-slot="session-turn-retry-message"]')).toContainText("Provider retry diagnostic")
  fixture.transport.enqueue({
    directory,
    payload: {
      type: "session.next.step.started",
      properties: {
        sessionID,
        timestamp: Date.now(),
        assistantMessageID: "msg_assistant_regression",
        agent: "build",
        model: { providerID: "zaovra", id: "claude-opus-4-6" },
      },
    },
  })
  await expect(page.locator('[data-slot="session-turn-retry"]')).toHaveCount(0)
  await expect(fixture.scroller).toBeVisible()
})
