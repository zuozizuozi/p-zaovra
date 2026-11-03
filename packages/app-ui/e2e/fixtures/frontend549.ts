import type { Page } from "@playwright/test"
import type { SessionMessage } from "@zaovra-ai/sdk/v2/client"
import { mockZaovraServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { directory, project, provider, session, sessionID } from "../performance/timeline-stability/fixture"

// Fixed local data only: no provider request or real workspace file is accessed.
export async function setupFrontend549(page: Page, baseURL: string, desktop = false) {
  await page.setViewportSize({ width: 1600, height: 900 })
  process.env.PLAYWRIGHT_PORT = new URL(baseURL).port
  process.env.PLAYWRIGHT_SERVER_PORT = new URL(baseURL).port
  if (desktop) {
    await page.route("**/*", async (route) => {
      if (!route.request().isNavigationRequest()) return route.fallback()
      const response = await route.fetch({ url: baseURL + "/e2e/fixtures/desktop550.html" })
      return route.fulfill({ response })
    })
    await page.addInitScript(
      (directory) =>
        localStorage.setItem(
          "zaovra.global.dat:server",
          JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, list: [], lastProject: {} }),
        ),
      directory,
    )
  }
  const now = Date.now()
  const messages: SessionMessage[] = [
    { type: "user", id: "msg_549_user", text: "检查五个后台任务，并生成结果文件。", time: { created: now - 5000 } },
    {
      type: "assistant",
      id: "msg_549_assistant",
      agent: "build",
      model: { id: "claude-opus-4-6", providerID: "zaovra" },
      time: { created: now - 4000, completed: now - 3000 },
      content: [
        {
          type: "reasoning",
          id: "part_reasoning",
          text: "# 核对任务结果\n先检查每个任务，再汇总结果。这段过程可以按需展开。",
        },
        ...Array.from({ length: 5 }, (_, index) => ({
          type: "tool" as const,
          id: "call_549_" + index,
          name: "bash",
          time: { created: now - 4000, completed: now - 3000 },
          state: {
            status: "completed" as const,
            input: { command: "check-" + (index + 1), run_in_background: true },
            structured: { job_id: "msg_549_job_" + index },
            content: [{ type: "text" as const, text: "后台任务已启动" }],
          },
        })),
        {
          type: "text",
          id: "part_result",
          text: "五项检查已完成。结果文件：[报告](report.docx) · [网页](result.html)",
        },
      ],
    },
    ...Array.from(
      { length: 5 },
      (_, index): SessionMessage => ({
        type: "shell",
        origin: "tool",
        id: "msg_549_job_" + index,
        callID: "call_549_" + index,
        command: "check-" + (index + 1),
        output: "检查通过 " + (index + 1),
        time: { created: now - 2500 + index, completed: now - 2000 + index },
      }),
    ),
    ...Array.from(
      { length: 5 },
      (_, index): SessionMessage => ({
        type: "synthetic",
        id: "msg_549_done_" + index,
        sessionID,
        text: "后台任务 " + (index + 1) + " 已完成",
        completion: { type: "bash-completion", sourceMessageID: "msg_549_assistant", jobID: "msg_549_job_" + index },
        time: { created: now - 1000 + index },
      }),
    ),
    {
      type: "synthetic",
      id: "msg_549_note",
      sessionID,
      text: "已收集五项检查的完成状态。",
      time: { created: now - 500 },
    },
  ]
  const transport = await installSseTransport(page, { server: baseURL })
  await mockZaovraServer(page, {
    directory,
    project: { ...project(), vcs: undefined, id: "global", name: "MCN 工作区" },
    provider: provider(),
    sessions: [
      session({ projectID: "global", title: "549 前端固定数据验收" }),
      session({ id: "ses_549_history", projectID: "global", title: "已关闭标签的历史对话" }),
    ],
    pageMessages: () => ({ items: messages }),
    sessionStatus: { [sessionID]: { type: "idle" } },
    activeSessions: {},
    fileContent: () => ({
      type: "text",
      content: "<!doctype html><title>Fixed preview</title><h1>本地网页预览</h1>",
      encoding: "utf8",
    }),
  })
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: {
          newLayoutDesigns: true,
          showReasoningSummaries: true,
          shellToolPartsExpanded: false,
          editToolPartsExpanded: false,
        },
      }),
    )
    localStorage.setItem("zaovra.global.dat:language", JSON.stringify({ locale: "zh" }))
  })
  await page.goto(baseURL + "/" + btoa(directory) + "/session/" + sessionID)
  await transport.waitForConnection({ timeout: 15_000 })
  return { transport }
}
