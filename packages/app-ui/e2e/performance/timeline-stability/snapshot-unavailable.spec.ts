import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { setupTimeline } from "./fixture"

for (const locale of ["zh", "en"] as const) {
  test(`real layout B snapshot warning in ${locale}`, async ({ page }, info) => {
    test.skip(!process.env.Y_SNAPSHOT_EVIDENCE, "Run the real core layout test and supply its evidence directory")
    await page.addInitScript(
      (scheme) => localStorage.setItem("zaovra-color-scheme", scheme),
      locale === "zh" ? "light" : "dark",
    )
    await setupTimeline(page, { locale, settings: { newLayoutDesigns: true } })
    let layout = "long"
    await page.route("**/api/session/**", async (route) => {
      if (!new URL(route.request().url()).pathname.endsWith("/message")) return route.fallback()
      const fixture = JSON.parse(
        await fs.readFile(path.join(process.env.Y_SNAPSHOT_EVIDENCE!, `snapshot-${layout}.json`), "utf8"),
        (_key, value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : value),
      )
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ data: fixture.messages, cursor: {} }),
      })
    })
    await page.reload()
    const warning = page.locator('[data-slot="snapshot-unavailable"]')
    await expect(warning).toHaveCount(1)
    await expect(warning).toHaveText(
      locale === "zh"
        ? "没有可用快照，本次文件改动无法撤销。"
        : "No usable snapshot is available. File changes in this step cannot be undone.",
    )
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", locale === "zh" ? "light" : "dark")
    await page.screenshot({ path: info.outputPath(`snapshot-${locale}.png`), fullPage: true })
    layout = "normal"
    await page.reload()
    await expect(page.getByText("File updated", { exact: true })).toBeVisible()
    await expect(warning).toHaveCount(0)
  })
}
