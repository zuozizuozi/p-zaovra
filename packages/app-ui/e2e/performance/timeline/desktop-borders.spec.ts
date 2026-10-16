import { expect, test } from "@playwright/test"
import { fixture } from "./session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressSessionHref,
} from "./timeline-test-helpers"

for (const scheme of ["light", "dark"] as const) {
  test(`desktop cards and selection have a single boundary in ${scheme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 960 })
    await mockStressTimeline(page)
    await installTimelineSettings(page)
    await installStressSessionTabs(page)
    await page.addInitScript((scheme) => {
      localStorage.setItem("zaovra-theme-id", "oc-2")
      localStorage.setItem("zaovra-color-scheme", scheme)
    }, scheme)
    await page.goto("/")
    const composer = page.locator('[data-component="prompt-input-v2"]').first()
    await expect(composer).toBeVisible()
    const titlebar = await page.locator('[data-slot="titlebar-v2"]').boundingBox()
    const workspace = await page.locator('[data-component="desktop-workspace"]').boundingBox()
    expect(titlebar).not.toBeNull()
    expect(workspace).not.toBeNull()
    expect(titlebar!.height).toBe(40)
    expect(workspace!.y - titlebar!.y - titlebar!.height).toBe(8)
    const shellColor = await page
      .locator('[data-slot="titlebar-v2"]')
      .evaluate((node) => getComputedStyle(node.parentElement!).backgroundColor)
    await expect(page.locator('[data-slot="titlebar-v2"]')).toHaveCSS("background-color", shellColor)
    await expect(composer).toHaveCSS("border-radius", "22px")
    await expect(composer).toHaveCSS("border-top-width", "1px")
    const toolbar = composer.locator('[data-slot="prompt-toolbar"]')
    await expect(toolbar).toHaveCSS("border-top-width", "0px")
    await expect(toolbar).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    const rail = page.locator('[data-component="desktop-rail"]')
    await expect(rail).toBeVisible()
    await expect(rail).toHaveCSS("border-right-width", "0px")
    await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
    await expect(page.locator('[data-component="desktop-sidebar-region"]')).toHaveCSS("width", "264px")
    await expect(page.locator('[data-component="desktop-sidebar-v2"]')).toHaveCSS("border-right-width", "1px")
    await expect(page.locator('[data-component="desktop-sidebar-v2"]')).toHaveCSS("border-radius", "14px")
    await expect(page.locator('[data-slot="channel-label"]')).toHaveCount(0)
    await expect(page.locator('[data-component="desktop-sidebar-v2"] [data-component="brand-mark"]')).toHaveCount(0)
    await expect(
      page.locator('[data-component="desktop-sidebar-v2"]').getByRole("img", { name: "Zaovra", exact: true }),
    ).toBeVisible()
    await page.screenshot({ path: info.outputPath("draft.png") })
    await page.goto(stressSessionHref(fixture.sourceID))
    await expect(composer).toBeVisible()
    const selected = page.locator(
      '[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"][data-active="true"]',
    )
    await expect(selected).toHaveCount(1)
    await expect(selected).toHaveCSS("box-shadow", "none")
    await expect(selected).toHaveCSS("border-left-width", "0px")
    await expect(selected).toHaveCSS("background-color", scheme === "light" ? "rgb(228, 228, 228)" : "rgb(54, 54, 54)")
    const bounds = await page
      .locator('[data-session-title] > div:first-child, [data-component="session-prompt-dock"] > div')
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return { left: rect.left + parseFloat(style.paddingLeft), right: rect.right - parseFloat(style.paddingRight) }
        }),
      )
    expect(bounds).toHaveLength(2)
    expect(Math.abs(bounds[0].left - bounds[1].left)).toBeLessThanOrEqual(1)
    expect(Math.abs(bounds[0].right - bounds[1].right)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: info.outputPath("session.png") })
    await page.keyboard.press("Control+,")
    const settings = page.locator(".settings-v2-page")
    await expect(settings).toBeVisible()
    const tab = settings
      .locator('[data-slot="tabs-v2-trigger-wrapper"]')
      .filter({ has: page.locator("[data-selected]") })
      .first()
    await expect(tab).toHaveCSS("border-left-width", "0px")
    await expect(tab).toHaveCSS("background-color", scheme === "light" ? "rgb(228, 228, 228)" : "rgb(54, 54, 54)")
    await page.screenshot({ path: info.outputPath("settings.png") })
  })
}
