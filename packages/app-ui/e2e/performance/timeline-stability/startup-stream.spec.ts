import { expect, test } from "@playwright/test"
import { assistantMessage, partDelta, partUpdated, setupTimeline, textPart, userMessage } from "./fixture"

test("keeps startup streaming layout stable as the first response grows", async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([], { completed: false })],
    viewport: { width: 980, height: 800 },
    locale: "zh",
    cpuRate: 4,
    seedHistory: true,
  })
  const id = "prt_startup_text"
  await timeline.send(partUpdated(textPart(id, "我准备好了。")), 100)
  await timeline.waitForPart(id)
  const text = "\n\n我擅长：\n- **软件工程任务**：代码编写、修改、调试、重构\n- **多文件操作**：读取、搜索、编辑项目中的文件\n- **代码审查与验证**：运行构建、测试、检查代码质量，验证游戏正常运行\n"
  for (const chunk of text.repeat(5).match(/.{1,8}|\n/g) ?? []) {
    await timeline.send(partDelta(id, chunk), 25)
  }
  await timeline.settle(10)
  await expect(page.locator(`[data-timeline-part-id="${id}"]`)).toContainText("正常运行")
  await testInfo.attach("layout-errors", { body: JSON.stringify(errors), contentType: "application/json" })
  expect(errors.filter((error) => error.includes("ResizeObserver"))).toEqual([])
})

test("preserves formatted lists while the next streamed chunk is being rendered", async ({ page }) => {
  const id = "prt_startup_list"
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([], { completed: false })],
    viewport: { width: 980, height: 800 },
    cpuRate: 4,
  })
  await timeline.send(partUpdated(textPart(id, "- **开始工作**：检查项目目录")), 100)
  const content = page.locator('[data-component="markdown"]')
  await expect(content.locator("li")).toBeVisible()
  await content.evaluate((element) => {
    element.setAttribute("data-list-disappeared", "false")
    const observer = new MutationObserver(() => {
      if (!element.querySelector("li")) element.setAttribute("data-list-disappeared", "true")
    })
    observer.observe(element, { childList: true, subtree: true })
    element.addEventListener("audit-finished", () => observer.disconnect(), { once: true })
  })
  for (const chunk of ["，然后", "编写游戏", "并验证", "运行结果。"])
    await timeline.send(partDelta(id, chunk), 100)
  await expect(content).toContainText("运行结果")
  await content.evaluate((element) => element.dispatchEvent(new Event("audit-finished")))
  await expect(content).toHaveAttribute("data-list-disappeared", "false")
})
