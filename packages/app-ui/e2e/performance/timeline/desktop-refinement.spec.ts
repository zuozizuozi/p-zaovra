import { expect, test } from "@playwright/test"
import { fixture } from "./session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressSessionHref,
} from "./timeline-test-helpers"

test("desktop project navigation stays in task flow and distinguishes duplicate names", async ({ page }, info) => {
  test.skip(process.env.D1B_DESKTOP_FIXTURE !== "1", "Requires desktop layout")
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.addInitScript(() => {
    const key = "zaovra.global.dat:server"
    const stored = JSON.parse(localStorage.getItem(key)!)
    stored.projects.local.push({ worktree: "C:/Other/smoke-project", expanded: true })
    localStorage.setItem(key, JSON.stringify(stored))
  })
  await page.goto(stressSessionHref(fixture.sourceID))
  const groups = page.locator('[data-slot="sidebar-project"]')
  await expect(groups).toHaveCount(2)
  await expect(groups.first().locator('[data-slot="titlebar-tab-item"]')).toHaveCount(1)
  const original = page.url()
  await groups.last().getByRole("button").first().click()
  await expect(page).toHaveURL(original)
  await expect(groups.first().locator('[data-slot="titlebar-tab-item"]')).toHaveCount(0)
  await expect(groups.last().getByRole("button").first()).toHaveAttribute("title", "C:/Other/smoke-project")
  await page.screenshot({ path: info.outputPath("multiple-projects.png") })
  await groups.first().getByRole("button", { name: "New session", exact: true }).click()
  await expect(page.locator('[data-component="session-new-design"]')).toBeVisible()
  await expect(page.locator('[data-slot="new-session-heading"]')).toHaveCSS("text-align", "center")
  await expect(page.locator('[data-slot="new-session-task"] button').filter({ hasText: "smoke-project" })).toHaveCount(
    1,
  )
  await expect(page.locator('[data-slot="new-session-task"] button').filter({ hasText: /^Local$/ })).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("single-project-selector.png") })
  await page.goto("/?view=projects")
  await expect(page.locator(".home-welcome")).toBeVisible()
  await expect(page.locator(".home-library")).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("legacy-project-link.png") })
})

test("release desktop hides server management and never connects saved remotes", async ({ page }, info) => {
  test.skip(process.env.D1C_RELEASE_FIXTURE !== "1", "Requires release desktop capability")
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.addInitScript(() => {
    const key = "zaovra.global.dat:server"
    const stored = JSON.parse(localStorage.getItem(key)!)
    stored.list = [{ type: "http", http: { url: "https://unwanted.invalid" } }]
    localStorage.setItem(key, JSON.stringify(stored))
  })
  const remoteRequests: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("unwanted.invalid")) remoteRequests.push(request.url())
  })
  await page.goto("/")
  await expect(page.locator(".home-welcome")).toBeVisible()
  await page.keyboard.press("Control+Comma")
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await expect(settings.getByRole("tab", { name: "Servers", exact: true })).toHaveCount(0)
  await expect(settings.getByRole("tab", { name: "General", exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath("release-settings.png") })
  expect(remoteRequests).toEqual([])
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("zaovra.global.dat:server")!).list)).toHaveLength(1)
})

test("Chinese system locale selects Chinese; stored unsupported locale falls back safely", async ({
  browser,
}, info) => {
  const context = await browser.newContext({ locale: "zh-CN" })
  const page = await context.newPage()
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.goto("/")
  await expect(page.locator("html")).toHaveAttribute("lang", "zh")
  await expect(page.locator(".home-welcome textarea")).toHaveAttribute("placeholder", /[\u4e00-\u9fff]/)
  await page.screenshot({ path: info.outputPath("chinese-new-task.png") })
  await page.evaluate(() => localStorage.setItem("zaovra.global.dat:language", JSON.stringify({ locale: "fr" })))
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("lang", "en")
  await page.keyboard.press("Control+Comma")
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("button", { name: "English", exact: true }).click()
  await expect(page.getByRole("option")).toHaveCount(2)
  await context.close()
})
