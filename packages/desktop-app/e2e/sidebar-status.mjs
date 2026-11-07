import assert from "node:assert/strict"
import { mainPath } from "./main-path.mjs"

export async function sidebarStatus(options) {
  const run = await mainPath(options)
  try {
    await options.onRuntime?.(run)
    await run.fresh()
    await run.connect()
    run.report.scope = "721 sidebar status"
    const input = run.page.locator('[data-component="prompt-input"][contenteditable="true"]')
    await input.fill("MP4：侧栏状态观测")
    const started = Date.now()
    await input.press("Enter")
    await run.page.getByText("实时回复已到达", { exact: true }).waitFor({ state: "visible" })
    run.report.sidebarStatus = { firstTextMs: Date.now() - started, url: run.page.url() }
    const active = run.page.locator(
      '[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"][data-active="true"] [data-slot="tab-link"]',
    )
    const href = await active.getAttribute("href")
    const session = /ses_[a-zA-Z0-9]+/.exec(href ?? "")?.[0]
    assert(session, "new visible session URL")
    const row = run.page
      .locator('[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"]')
      .filter({ has: run.page.locator('a[href*="' + session + '"]') })
    await row.waitFor({ state: "visible" })
    Object.assign(run.report.sidebarStatus, { session, running: await row.innerText(), providerFinished: false })
    if (!options.tailOnly) await run.capture("721-sidebar-running")
    if (!options.tailOnly) {
      await row.getByText("进行中", { exact: true }).waitFor({ state: "visible", timeout: 5000 })
      run.report.sidebarStatus.runningPassed = true
    }
    run.report.sidebarStatus.tailOnly = !!options.tailOnly
    await run.page.getByRole("button", { name: "新对话", exact: true }).last().click()
    await run.page.getByText("实时回复已到达", { exact: true }).waitFor({ state: "hidden" })
    assert.equal(
      await row.getByText("待看", { exact: true }).count(),
      0,
      "held provider is still running, no completion badge",
    )
    run.control.stream.resolve()
    await row.getByText("待看", { exact: true }).waitFor({ state: "visible", timeout: 30000 })
    run.report.sidebarStatus.unread = await row.innerText()
    await run.capture("721-sidebar-unread")
    await row.locator('[data-slot="tab-link"]').click()
    await row.getByText("待看", { exact: true }).waitFor({ state: "hidden" })
    await run.page.locator('[data-component="permission-chip"]').click()
    await run.page.locator('[data-permission-menu] [data-mode="ask"]').click()
    await input.fill("MP5：请求执行本地命令，等待我处理权限")
    await input.press("Enter")
    const card = run.page.locator('[data-component="dock-prompt"][data-kind="permission"]')
    await card.waitFor({ state: "visible", timeout: 90000 })
    await row.getByText("待处理", { exact: true }).waitFor({ state: "visible" })
    run.report.sidebarStatus.pending = await row.innerText()
    run.report.sidebarStatus.layout = await row.evaluate((element) => {
      const badge = element.querySelector('[data-slot="sidebar-session-status"]')?.getBoundingClientRect()
      const title = element.querySelector('[data-slot="tab-title"]')?.getBoundingClientRect()
      const bounds = element.getBoundingClientRect()
      return { badge: badge?.toJSON(), title: title?.toJSON(), row: bounds.toJSON() }
    })
    const layout = run.report.sidebarStatus.layout
    assert(
      layout.badge && layout.title && layout.title.width > 20 && layout.badge.right <= layout.row.right,
      "label fits beside truncated title",
    )
    await run.capture("721-sidebar-pending")
    await card.getByRole("button", { name: "拒绝", exact: true }).click()
    await card.waitFor({ state: "hidden" })
    await row.getByText("待处理", { exact: true }).waitFor({ state: "hidden" })
    run.report.sidebarStatus.passed = true
  } catch (error) {
    await run.capture("721-sidebar-status-failure").catch(() => {})
    throw error
  } finally {
    await run.close()
  }
  return run
}
