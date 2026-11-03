import { test, expect } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"
import { setupFrontend549 } from "./frontend549"

test("549/550 production UI before-after and interactive controls", async ({ page, browser }) => {
  test.setTimeout(180_000)
  const root = process.env.QA_549_ROOT!
  const shots = root + "/screenshots/" + (process.env.QA_549_SHOT_ID ?? Date.now().toString())
  await mkdir(shots, { recursive: true })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const before = await browser.newPage({ viewport: { width: 1600, height: 900 }, locale: "zh-CN" })
  await setupFrontend549(before, "http://127.0.0.1:4561")
  await expect(before.getByText("检查五个后台任务，并生成结果文件。", { exact: true })).toBeVisible()
  await before.screenshot({ path: shots + "/before549.png" })
  await before.close()
  await setupFrontend549(page, "http://127.0.0.1:4562")
  await expect(page.getByText("检查五个后台任务，并生成结果文件。", { exact: true })).toBeVisible()
  await expect(page.getByText("系统跟进", { exact: true })).toHaveCount(0)
  const reasoning = page.locator('[data-component="reasoning-block"]')
  console.log(
    "FRONTEND_549_DIAGNOSTIC",
    await page.evaluate(() => ({
      settings: localStorage.getItem("settings.v3"),
      parts: [...document.querySelectorAll("[data-component=reasoning-part]")].length,
    })),
  )
  await expect(reasoning).toHaveCount(1)
  await expect(reasoning).not.toHaveAttribute("open", "")
  await page.screenshot({ path: shots + "/after549.png" })
  await reasoning.locator("summary").click()
  await expect(reasoning).toHaveAttribute("open", "")
  await page.screenshot({ path: shots + "/reasoning-expanded549.png" })
  await reasoning.locator("summary").click()
  await page.getByRole("button", { name: /^用时/ }).click()
  const commands = page.locator('[data-component="process-tool-group"]')
  await commands.locator("summary").click()
  await expect(commands.locator('[data-component="tool-part-wrapper"]')).toHaveCount(5)
  await page.screenshot({ path: shots + "/five-background-cards549.png" })
  const chip = page.locator('[data-component="permission-chip"]')
  await chip.click()
  await expect(page.getByRole("menuitem", { name: /^自动\s/ })).toBeVisible()
  await page.screenshot({ path: shots + "/permission-choices550.png" })
  await page.getByRole("menuitem").filter({ hasText: "完全权限" }).click()
  await expect(chip).toHaveAttribute("data-mode", "full")
  await expect(page.locator('[data-slot="full-access-warning"]')).toBeVisible()
  await page.screenshot({ path: shots + "/full-access550.png" })
  await chip.click()
  await page.getByRole("menuitem", { name: /^自动\s/ }).click()
  await expect(chip).toHaveAttribute("data-mode", "automatic")
  await page.reload()
  await expect(chip).toHaveAttribute("data-mode", "automatic")
  const download: string[] = []
  page.on("download", (file) => download.push(file.suggestedFilename()))
  await page.getByRole("link", { name: "报告", exact: true }).click()
  await expect(page.locator('[data-component="artifact-external"]')).toBeVisible()
  await expect(page.getByRole("button", { name: "用系统默认程序打开", exact: true })).toBeDisabled()
  await page.screenshot({ path: shots + "/file-external549.png" })
  expect(download).toEqual([])
  await page.setViewportSize({ width: 1100, height: 760 })
  await page.screenshot({ path: shots + "/narrow550.png" })
  const fit = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth)
  await writeFile(
    root + "/ui-qa549.json",
    JSON.stringify(
      {
        fit,
        errors,
        download,
        checks: [
          "before-after",
          "no system followup",
          "reasoning collapse-expand",
          "three permission choices",
          "full warning",
          "project persistence reload",
          "no docx download",
        ],
      },
      null,
      2,
    ),
  )
  expect(errors).toEqual([])
  // Keep the owned window available for the separate Computer Use observation.
  if (process.env.QA_549_COMPUTER_USE === "true") await page.waitForTimeout(90_000)
})

test("550 real desktop layout shows project history and independent sidebar controls", async ({ page }) => {
  test.setTimeout(120_000)
  const root = process.env.QA_549_ROOT!
  await setupFrontend549(page, "http://127.0.0.1:4562", true)
  const sidebar = page.locator('[data-component="desktop-sidebar-v2"]')
  await page.getByRole("button", { name: "切换侧边栏", exact: true }).click()
  await expect(sidebar).toBeVisible()
  await expect(sidebar.getByText("已关闭标签的历史对话", { exact: true })).toBeVisible()
  await expect(sidebar.locator('[data-slot="new-session-project"]')).toContainText("MCN 工作区")
  await expect.poll(() => sidebar.evaluate(element =>
    element.getBoundingClientRect().right <= element.parentElement!.getBoundingClientRect().right + 0.5,
  )).toBe(true)
  await page.screenshot({
    path: root + "/screenshots/desktop-sidebar-" + (process.env.QA_549_SHOT_ID ?? Date.now()) + ".png",
  })
  const collapse = sidebar.locator("button[aria-expanded=true]").first()
  await collapse.click()
  await expect(sidebar.getByText("已关闭标签的历史对话", { exact: true })).toHaveCount(0)
  await sidebar.locator("button[aria-expanded=false]").first().click()
  await expect(sidebar.getByText("已关闭标签的历史对话", { exact: true })).toBeVisible()
  if (process.env.QA_549_COMPUTER_USE === "true") await page.waitForTimeout(90_000)
})
