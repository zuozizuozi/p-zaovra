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
    await installStressSessionTabs(page)
    await page.addInitScript((scheme) => localStorage.setItem("zaovra-color-scheme", scheme), scheme)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(stressSessionHref(fixture.sourceID))
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    if (process.env.D1B_DESKTOP_FIXTURE === "1") {
      await expect(page.locator('[data-component="desktop-sidebar-v2"]')).toHaveCSS("width", "276px")
      await expect(
        page.locator('[data-component="desktop-sidebar-v2"] [data-slot="titlebar-tab-item"]').first(),
      ).toBeVisible()
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
  })
}
