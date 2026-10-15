import fs from "node:fs/promises"
import { expect, test } from "@playwright/test"
import { setupTimeline, sessionID } from "./fixture"

for (const locale of ["zh", "en"] as const) {
  test(`real MCP approval metadata renders safely in ${locale}`, async ({ page }, info) => {
    if (!process.env.W_MCP_EVIDENCE) throw new Error("Run mcp-approval.test.ts with W_MCP_EVIDENCE first")
    const requests = JSON.parse(await fs.readFile(process.env.W_MCP_EVIDENCE, "utf8"))
    let current = 0
    const decisions: unknown[] = []
    await page.addInitScript(
      (scheme) => localStorage.setItem("zaovra-color-scheme", scheme),
      locale === "zh" ? "light" : "dark",
    )
    await setupTimeline(page, { locale, settings: { newLayoutDesigns: true } })
    await page.route("**/api/permission/request*", (route) =>
      route.fulfill({ json: { data: [{ ...requests[current], sessionID }] } }),
    )
    await page.route("**/api/session/*/permission/*/reply", (route) => {
      decisions.push({ url: route.request().url(), body: route.request().postDataJSON() })
      return route.fulfill({ json: { data: true } })
    })
    await page.reload()
    const card = page.locator('[data-slot="mcp-approval"]')
    await expect(card).toBeVisible()
    await expect(card).toContainText("fixture")
    await expect(card).toContainText("echo")
    await expect(card.locator("pre")).toHaveText(JSON.stringify(requests[0].metadata.mcpArguments, null, 2))
    await expect(card).not.toContainText("fixture-secret")
    await expect(card).not.toContainText("fixture-password")
    await expect(card).not.toContainText("fixture-token")
    await page.screenshot({ path: info.outputPath(`mcp-${locale}.png`), fullPage: true })
    current = 1
    await page.reload()
    await expect(card.locator("pre")).toHaveText(JSON.stringify(requests[1].metadata.mcpArguments, null, 2))
    expect(decisions).toEqual([])
    await page.getByRole("button", { name: locale === "zh" ? "允许一次" : "Allow once", exact: true }).click()
    await expect.poll(() => decisions.length).toBe(1)
    expect(JSON.stringify(decisions)).toContain(requests[1].id)
    expect(JSON.stringify(decisions)).not.toContain(requests[0].id)
    current = 3
    await page.reload()
    await expect(card.locator("details")).not.toHaveAttribute("open")
    await card.locator("summary").click()
    await expect(card.locator("pre")).toHaveText(JSON.stringify(requests[3].metadata.mcpArguments, null, 2))
  })
}
