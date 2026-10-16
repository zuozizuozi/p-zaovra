import { fixture } from "./session-timeline-stress.fixture"
import { expect, test } from "@playwright/test"
import {
  installTimelineSettings,
  mockStressTimeline,
  installStressSessionTabs,
  stressSessionHref,
} from "./timeline-test-helpers"

for (const locale of ["zh", "en"] as const)
  test(`effective shell identity in ${locale}`, async ({ page }, info) => {
    await mockStressTimeline(page)
    await installTimelineSettings(page)
    await installStressSessionTabs(page)
    await page.addInitScript((locale) => {
      localStorage.setItem("zaovra.global.dat:language", JSON.stringify({ locale }))
      localStorage.setItem("zaovra-theme-id", "oc-2")
      localStorage.setItem("zaovra-color-scheme", locale === "zh" ? "light" : "dark")
    }, locale)
    await page.route("**/pty/shells*", (route) =>
      route.fulfill({
        json: [
          {
            path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
            name: "powershell",
            acceptable: true,
            effective: true,
            version: "7.4.6",
            kind: "powershell",
            source: "project",
          },
        ],
      }),
    )
    await page.goto(stressSessionHref(fixture.sourceID))
    await expect(page.locator('[data-component="prompt-input"]').first()).toBeVisible()
    await page.keyboard.press("Control+Comma")
    const status = page.locator('[data-component="shell-status"]')
    await expect(status).toContainText("PowerShell 7.4.6")
    await expect(status).toContainText("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
    await expect(status).toContainText(
      locale === "zh" ? "项目配置（覆盖全局）" : "Project configuration (overrides global)",
    )
    await status.scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath(`shell-${locale}.png`) })
  })
