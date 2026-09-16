import { expect, test } from "@playwright/test"
import { setupTimelineBenchmark } from "./session-timeline-benchmark.fixture"

test("pending turn review keeps the conversation and composer visible", async ({ page }) => {
  const fixture = await setupTimelineBenchmark(page, {
    historyTurns: 2,
    eventBatch: 1,
    newLayoutDesigns: true,
    git: false,
  })
  let release = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const requests: string[] = []
  await page.route(/\/api\/session\/[^/]+\/message\/[^/]+\/diff(?:\?|$)/, async (route) => {
    requests.push(route.request().url())
    await pending
    await route.fulfill({ json: { data: [] } })
  })
  await page.getByRole("button", { name: "Toggle review" }).click()
  fixture.transport.enqueue({
    directory: "C:/Zaovra/TimelineStateRegression",
    payload: {
      type: "session.next.step.started",
      properties: {
        sessionID: "ses_timeline_state_regression",
        timestamp: Date.now(),
        assistantMessageID: "msg_review_pending",
        agent: "build",
        model: { providerID: "zaovra", id: "claude-opus-4-6" },
      },
    },
  })
  try {
    await expect.poll(() => requests.length).toBeGreaterThan(0)
    await expect(fixture.scroller).toBeVisible()
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible()
    expect(requests.every((url) => url.includes("/message/msg_user_regression/diff"))).toBe(true)
  } finally {
    release()
  }
  await expect(fixture.scroller).toBeVisible()
})

test("shell history does not become the user turn used for review", async ({ page }) => {
  const fixture = await setupTimelineBenchmark(page, {
    historyTurns: 0,
    eventBatch: 1,
    newLayoutDesigns: true,
    git: false,
  })
  const requests: string[] = []
  await page.route(/\/api\/session\/[^/]+\/message\/[^/]+\/diff(?:\?|$)/, async (route) => {
    requests.push(route.request().url())
    await route.fulfill({ json: { data: [] } })
  })
  await page.route(/\/api\/session\/[^/]+\/message(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        data: [
          { id: "msg_user_regression", type: "user", text: "Please edit the file.", time: { created: 1 } },
          {
            id: "msg_shell_review",
            type: "shell",
            callID: "call_preview",
            command: "preview",
            output: "ready",
            time: { created: 2, completed: 3 },
          },
          {
            id: "msg_review_after_shell",
            type: "assistant",
            agent: "build",
            model: { providerID: "zaovra", id: "claude-opus-4-6" },
            content: [{ id: "text", type: "text", text: "Preview ready." }],
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 4, completed: 5 },
            finish: "stop",
          },
        ],
        cursor: {},
      },
    }),
  )
  await page.getByRole("button", { name: "Toggle review" }).click()
  fixture.transport.enqueue({
    directory: "C:/Zaovra/TimelineStateRegression",
    payload: {
      type: "session.next.shell.ended",
      properties: { sessionID: "ses_timeline_state_regression", timestamp: Date.now() },
    },
  })
  await expect(page.getByText("Preview ready.", { exact: true })).toBeVisible()
  await expect.poll(() => requests.length).toBeGreaterThan(0)
  expect(requests.every((url) => url.includes("/message/msg_user_regression/diff"))).toBe(true)
  await expect(fixture.scroller).toBeVisible()
})
