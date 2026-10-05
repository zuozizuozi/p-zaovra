import { expect, test } from "@playwright/test"
import { expectSessionTitle } from "../../utils/waits"
import { fixture } from "./session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressSessionHref,
} from "./timeline-test-helpers"

test("fresh profile stays light on a dark OS; theme and font preferences survive reload", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "dark" })
  await mockStressTimeline(page)
  await page.addInitScript(() => {
    if (!localStorage.getItem("settings.v3")) {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    }
  })
  await installStressSessionTabs(page)
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
  await expect(page.locator("body")).toHaveCSS("font-family", /Inter/)
  await page.keyboard.press("Control+Comma")
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  const scheme = settings.locator('[data-action="settings-color-scheme"]')
  await scheme.click()
  await page.getByRole("option", { name: "Dark", exact: true }).click()
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark")
  await settings.locator('[data-action="settings-ui-font"]').fill("Arial")
  await expect(page.locator("body")).toHaveCSS("font-family", /^Arial,/)
  await page.screenshot({ path: info.outputPath("settings-dark.png") })
  await page.reload()
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark")
  await expect(page.locator("body")).toHaveCSS("font-family", /^Arial,/)
  await page.keyboard.press("Control+Comma")
  await scheme.click()
  await page.getByRole("option", { name: "Light", exact: true }).click()
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light")
  // Select's popup is a separate dismissible layer. Dismiss it before the dialog.
  await page.keyboard.press("Escape")
  await expect(page.getByRole("listbox")).toBeHidden()
  await page.screenshot({ path: info.outputPath("settings-light.png") })
  await settings.getByRole("button", { name: "Close", exact: true }).click()
  await expect(settings).toBeHidden()
})

for (const scheme of ["light", "dark", "system"] as const) {
  test(`preserves saved ${scheme} and renders the workbench`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: "dark" })
    await mockStressTimeline(page)
    await installTimelineSettings(page)
    await installStressSessionTabs(page, { draftID: "brand-draft" })
    await page.addInitScript((scheme) => {
      localStorage.setItem("zaovra-color-scheme", scheme)
      localStorage.setItem("zaovra-theme-id", "nord")
      localStorage.setItem("zaovra-theme-css-light", "--legacy-cache: light")
      localStorage.setItem("zaovra-theme-css-dark", "--legacy-cache: dark")
    }, scheme)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(stressSessionHref(fixture.sourceID))
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    await expect(page.locator("html")).toHaveAttribute("data-theme", "oc-2")
    expect(
      await page.evaluate(() => [
        localStorage.getItem("zaovra-theme-id"),
        localStorage.getItem("zaovra-theme-css-light"),
        localStorage.getItem("zaovra-theme-css-dark"),
      ]),
    ).toEqual(["oc-2", null, null])
    await expect(page.locator('[data-slot="assistant-heading"]').last()).toContainText("Zaovra")
    await expect(page.locator('[data-slot="assistant-model"]').last()).toHaveText("Claude Opus 4.6")
    if (process.env.D1B_DESKTOP_FIXTURE === "1") {
      const sidebar = page.locator('[data-component="desktop-sidebar-v2"]')
      await expect(sidebar).toHaveCSS("width", "276px")
      await expect(sidebar.locator('[data-component="brand-mark"]')).toBeVisible()
      await expect(sidebar.locator('[data-component="logo-mark"]')).toHaveCount(0)
      const tab = sidebar.locator('[data-slot="titlebar-tab-item"]').first()
      await expect(tab.locator('[data-slot="session-conversation-icon"]')).toBeVisible()
      const close = tab.locator('[data-slot="tab-close"]')
      await page.mouse.move(1400, 990)
      await expect(close).toHaveCSS("opacity", "0")
      await tab.hover()
      await expect(close).toHaveCSS("opacity", "1")
      await page.mouse.move(1400, 990)
      await close.getByRole("button", { name: "Close", exact: true }).focus()
      await expect(close).toHaveCSS("opacity", "1")
      await sidebar.getByText("Projects", { exact: true }).click()
    }
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", scheme === "light" ? "light" : "dark")
    const results = await page.evaluate(() => {
      const probe = document.createElement("span")
      probe.style.cssText = "color:var(--zaovra-on-accent);background:var(--zaovra-accent)"
      document.body.append(probe)
      const style = getComputedStyle(probe)
      const colors = { foreground: style.color, background: style.backgroundColor }
      probe.remove()
      return colors
    })
    expect(results).toEqual(
      scheme === "light"
        ? { foreground: "rgb(255, 255, 255)", background: "rgb(124, 58, 237)" }
        : { foreground: "rgb(15, 15, 23)", background: "rgb(196, 181, 253)" },
    )
    await info.attach("computed-colors", { body: JSON.stringify(results), contentType: "application/json" })
    await page.screenshot({ path: info.outputPath(`${scheme}-wide.png`) })
    if (scheme !== "system") {
      await page.getByRole("button", { name: "查看成果", exact: true }).click()
      const artifacts = page.locator('[data-component="artifacts-panel"]')
      await expect(artifacts).toBeVisible()
      await artifacts.locator("input").fill("index.html")
      await expect(artifacts.getByRole("button", { name: "打开", exact: true })).toHaveCSS("color", results.foreground)
      await expect(artifacts.getByRole("button", { name: "打开", exact: true })).toHaveCSS(
        "background-color",
        results.background,
      )
      await page.screenshot({ path: info.outputPath(`${scheme}-artifacts.png`) })
      await page.getByRole("button", { name: "Toggle review", exact: true }).click()
      await page.keyboard.press("Control+Comma")
      const settings = page.getByRole("dialog", { name: "Settings", exact: true })
      await settings.locator('[data-action="settings-theme"]').click()
      await expect(page.getByRole("option")).toHaveCount(1)
      await expect(page.getByRole("option")).toHaveText("Zaovra")
      await page.keyboard.press("Escape")
      await expect(page.getByRole("listbox")).toBeHidden()
      await page.screenshot({ path: info.outputPath(`${scheme}-settings.png`) })
      await settings.getByRole("button", { name: "Close", exact: true }).click()
    }
    await page.setViewportSize({ width: 820, height: 1100 })
    if (process.env.D1B_DESKTOP_FIXTURE === "1") {
      await expect(page.locator('[data-component="desktop-sidebar-v2"]')).toHaveCSS("width", "220px")
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`${scheme}-narrow.png`) })
    if (scheme === "system") {
      await page.emulateMedia({ colorScheme: "light" })
      await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
      await expect(page.locator("html")).toHaveCSS("color-scheme", "light")
    }
    if (scheme === "light") {
      await page.goto("/")
      const mark = page.locator('.home-welcome [data-component="brand-mark"]')
      await expect(mark).toBeVisible()
      await expect.poll(() => mark.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      await page.screenshot({ path: info.outputPath("new-task.png") })
    }
  })
}
