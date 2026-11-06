import { expect, test } from "@playwright/test"
import {
  assistantID,
  directory,
  sessionID,
  userID,
  assistantMessage,
  setupTimeline,
  textPart,
  toolPart,
  userMessage,
} from "./fixture"

test("700 keeps a completed answer visible while a later empty step is busy", async ({ page }) => {
  const delivered = assistantMessage([textPart("prt_700_answer", "Word 文档已生成：C:/output/report.docx")])
  delivered.info.finish = "stop"
  const pending = assistantMessage([], { id: "msg_1002_empty_step", created: 1700000004000, completed: false })
  await setupTimeline(page, {
    messages: [userMessage(), delivered, pending],
    locale: "zh",
    settings: { newLayoutDesigns: true },
  })
  await expect(page.getByText("Word 文档已生成：C:/output/report.docx", { exact: true })).toBeVisible()
})

test("700 keeps exploratory command failures in process details after successful delivery", async ({ page }) => {
  const failed = assistantMessage([
    toolPart(
      "prt_700_failed",
      "bash",
      "error",
      { command: "python probe.py" },
      {
        error:
          "Command exited with code 1\nFile not found: optional-template.txt\n    at SessionRunner.runTurn (core/src/session/runner/llm.ts:1:1)\n    at ToolRegistry.settle (core/src/tool/registry.ts:1:1)",
        metadata: { exit: 1 },
      },
    ),
  ])
  failed.info.finish = "tool-calls"
  const saved = toolPart("prt_700_saved", "write", "completed", { path: "report.docx" }, { metadata: {} })
  saved.state.time = { start: 1700000003000, end: 1700000003500 }
  const delivered = assistantMessage([saved, textPart("prt_700_delivery", "Word 文档已生成：report.docx")], {
    id: "msg_1002_delivery",
    created: 1700000004000,
  })
  delivered.info.finish = "stop"
  await setupTimeline(page, {
    messages: [userMessage(), failed, delivered],
    locale: "zh",
    settings: { newLayoutDesigns: true },
  })
  await expect(page.getByText("Word 文档已生成：report.docx", { exact: true })).toBeVisible()
  await expect(page.locator('[data-kind="tool-error-card"]')).toHaveCount(0)
  await expect(page.locator('[data-slot="turn-terminal-status"]')).toHaveCount(0)
  await page.locator('[data-component="turn-process-summary"] button').first().click()
  await page.locator('[data-component="tool-recovery-summary"] button').first().click()
  await expect(page.getByText("python probe.py", { exact: false })).toBeVisible()
  await expect(
    page.locator('[data-component="tool-recovery-summary"]').getByText("optional-template.txt", { exact: false }),
  ).toBeVisible()
  await expect(page.getByText("SessionRunner.runTurn", { exact: false })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("completed-with-process-failure.png"), fullPage: true })
})

test("700 command failure details omit host stack frames", async ({ page }) => {
  const failed = assistantMessage([
    toolPart(
      "prt_700_stack",
      "bash",
      "error",
      { command: "python failed.py" },
      {
        error:
          "Command exited with code 2\nMissing required argument\n    at SessionRunner.runTurn (core/src/session/runner/llm.ts:1:1)\n    at ToolRegistry.settle (core/src/tool/registry.ts:1:1)",
        metadata: { exit: 2 },
      },
    ),
  ])
  failed.info.finish = "stop"
  await setupTimeline(page, { messages: [userMessage(), failed], locale: "zh", settings: { newLayoutDesigns: true } })
  await page.locator('[data-component="turn-process-summary"] button').first().click()
  const card = page.locator('[data-kind="tool-error-card"]')
  await expect(card).toBeVisible()
  await card.locator('[data-component="tool-trigger"]').click()
  await expect(card).toContainText("Missing required argument")
  await expect(card).not.toContainText("SessionRunner.runTurn")
  await expect(card).not.toContainText("ToolRegistry.settle")
})

test("701 reconnect resyncs the current answer without switching sessions", async ({ page }) => {
  const fixture = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([], { completed: false })],
    locale: "zh",
    settings: { newLayoutDesigns: true },
  })
  const transcript = [
    { type: "user", id: userID, text: "Build the timeline stability matrix.", time: { created: 1700000000000 } },
    {
      type: "assistant",
      id: assistantID,
      agent: "build",
      model: { id: "claude-opus-4-6", providerID: "zaovra" },
      finish: "stop",
      time: { created: 1700000001000, completed: 1700000003000 },
      content: [{ id: "reconnect-answer", type: "text", text: "断流后的最终答复701" }],
    },
  ]
  await page.route("**/api/session/*/message?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: transcript, cursor: {} }),
    }),
  )
  await page.route("**/api/session/active", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {} }) }),
  )
  const first = (await fixture.transport.connections()).at(-1)!
  await fixture.transport.disconnect()
  await fixture.transport.waitForConnection({ after: first.id })
  await fixture.transport.writeRaw(
    "data: " + JSON.stringify({ directory: "global", payload: { type: "server.connected", properties: {} } }) + "\n\n",
  )
  await expect(page.getByText("断流后的最终答复701", { exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath("reconnected-answer.png") })
})

test("701 steer and queue admissions appear as labeled bubbles", async ({ page }) => {
  const fixture = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([], { completed: false })],
    locale: "zh",
    settings: { newLayoutDesigns: true },
  })
  const pending = [
    {
      id: "msg_701_steer",
      sessionID,
      admittedSeq: 5,
      timeCreated: 1700000005000,
      delivery: "steer",
      prompt: { text: "立即插入701" },
    },
    {
      id: "msg_701_queue",
      sessionID,
      admittedSeq: 6,
      timeCreated: 1700000006000,
      delivery: "queue",
      prompt: { text: "稍后排队701" },
    },
  ]
  await page.route("**/api/session/*/input/pending", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: pending }) }),
  )
  for (const item of pending)
    await fixture.transport.writeRaw(
      "data: " +
        JSON.stringify({
          directory,
          payload: {
            type: "session.next.prompt.admitted",
            properties: {
              sessionID,
              messageID: item.id,
              timestamp: item.timeCreated,
              delivery: item.delivery,
              prompt: item.prompt,
            },
          },
        }) +
        "\n\n",
    )
  await expect(page.getByText("立即插入701", { exact: true })).toBeVisible()
  await expect(page.getByText("稍后排队701", { exact: true })).toBeVisible()
  await expect(page.getByText("已插入，下一步生效", { exact: true })).toBeVisible()
  await expect(page.getByText("排队中，任务结束后发送", { exact: true })).toBeVisible()
  await expect(page.locator('[data-component="session-followup-dock"]')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("pending-bubbles.png") })
})

test("701 an expired permission becomes noninteractive with readable feedback", async ({ page }) => {
  const fixture = await setupTimeline(page, {
    messages: [userMessage()],
    locale: "zh",
    settings: { newLayoutDesigns: true },
  })
  await page.route("**/api/session/*/permission/per_expired701/reply", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        name: "NotFoundError",
        data: { message: "Permission request not found: per_expired701" },
      }),
    }),
  )
  await fixture.transport.writeRaw(
    "data: " +
      JSON.stringify({
        directory,
        payload: {
          type: "permission.v2.asked",
          properties: {
            id: "per_expired701",
            sessionID,
            action: "bash",
            resources: ["echo fixture"],
            save: [],
            metadata: {},
          },
        },
      }) +
      "\n\n",
  )
  const allow = page.getByRole("button", { name: "允许一次", exact: true })
  await expect(allow).toBeVisible()
  await allow.click()
  await expect(page.getByText("此权限请求已失效，请等待新的请求。", { exact: true })).toBeVisible()
  await expect(allow).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("expired-permission.png") })
})
