import { expect, test } from "@playwright/test"
import { installStressSessionTabs, installTimelineSettings, mockStressTimeline } from "./timeline-test-helpers"

test("sidebar collapse does not depend on the theme selector", async ({ page }) => {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")
  // Desktop pins oc-2; remove its selector only to exercise the layout fallback.
  await page.locator("html").evaluate((node) => node.removeAttribute("data-theme"))
  const region = page.locator('[data-component="desktop-sidebar-region"]')
  const toggle = page.getByRole("button", { name: "Toggle sidebar", exact: true })
  if ((await region.getAttribute("data-open")) !== "true") await toggle.click()
  await expect(region).toHaveCSS("width", "280px")
  await toggle.click()
  await expect(region).toHaveCSS("width", "0px")
  await expect(region).toHaveAttribute("inert", "")
})

for (const scheme of ["light", "dark"] as const) {
  test(`desktop edge and interruptible sidebar in ${scheme}`, async ({ page }, info) => {
    await mockStressTimeline(page)
    await installTimelineSettings(page)
    await installStressSessionTabs(page)
    await page.addInitScript((scheme) => {
      localStorage.setItem("zaovra-theme-id", "oc-2")
      localStorage.setItem("zaovra-color-scheme", scheme)
    }, scheme)
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.goto("/")
    const region = page.locator('[data-component="desktop-sidebar-region"]')
    const toggle = page.getByRole("button", { name: "Toggle sidebar", exact: true })
    if ((await region.getAttribute("data-open")) !== "true") await toggle.click()
    await expect(region).toHaveCSS("width", "264px")
    const input = page.locator('[data-component="prompt-input-v2"] [contenteditable="true"]').first()
    await input.fill("Preserve this task while toggling")
    const sidebar = await page.locator('[data-component="desktop-sidebar-v2"]').elementHandle()
    const edge = await page.locator('[data-window-edge="windows"]').evaluate((node) => {
      const style = getComputedStyle(node, "::before")
      return {
        height: style.height,
        top: style.top,
        width: style.width,
        events: style.pointerEvents,
        viewport: innerWidth,
      }
    })
    expect(edge).toEqual({
      height: "1px",
      top: "0px",
      width: `${edge.viewport}px`,
      events: "none",
      viewport: edge.viewport,
    })
    // Seek the actual CSS transition, rather than rely on the machine's frame rate.
    await toggle.click()
    await expect(region).toHaveAttribute("inert", "")
    const middle = await region.evaluate((node) => {
      const animation = node
        .getAnimations()
        .find((item) => item instanceof CSSTransition && item.transitionProperty === "width")
      if (!animation) throw new Error("Sidebar collapsed without a width transition")
      animation.pause()
      animation.currentTime = 80
      return node.getBoundingClientRect().width
    })
    expect(middle).toBeGreaterThan(0)
    expect(middle).toBeLessThan(264)
    await page.screenshot({ path: info.outputPath("mid-collapse.png") })
    await toggle.click()
    await expect(region).toHaveCSS("width", "264px")
    expect(await sidebar!.evaluate((node) => node.isConnected)).toBe(true)
    await expect(input).toContainText("Preserve this task while toggling")
    await page.emulateMedia({ reducedMotion: "reduce" })
    await toggle.click()
    await expect(region).toHaveCSS("width", "0px")
    await expect(region).toHaveCSS("visibility", "hidden")
    expect(await region.evaluate((node) => node.getAnimations().length)).toBe(0)
    await expect(input).toContainText("Preserve this task while toggling")
  })
}
