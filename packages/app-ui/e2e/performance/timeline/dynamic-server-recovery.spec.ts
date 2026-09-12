import { expect, test } from "@playwright/test"
import { fixture } from "./session-timeline-stress.fixture"
import { installStressSessionTabs, installTimelineSettings, mockStressTimeline, stressDraftHref, stressSessionHref } from "./timeline-test-helpers"

test.skip(!process.env.ZAOVRA_AUDIT_DYNAMIC_SERVERS, "Requires the isolated dynamic server list build")
test("updated server credentials reach subsequent session requests", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.goto(stressSessionHref(fixture.sourceID))
  await expect(page.locator('[data-component="prompt-input"][contenteditable="true"]').first()).toBeVisible()
  const requests: Array<string | undefined> = []
  page.on("request", (request) => { if (request.url().includes(`/session/${fixture.targetID}`)) requests.push(request.headers().authorization) })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("audit-server-password", { detail: { password: "audit-fixture-password" } })))
  await page.locator(`[data-slot="titlebar-tabs"] a[href="${stressSessionHref(fixture.targetID)}"]`).first().click()
  await expect.poll(() => requests).toContain(`Basic ${Buffer.from("zaovra:audit-fixture-password").toString("base64")}`)
  expect(errors).toEqual([])
})

for (const kind of ["session", "draft"]) {
  test(`${kind} route and unsent input recover when its server reappears`, async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
    await mockStressTimeline(page)
    await installTimelineSettings(page)
    await installStressSessionTabs(page, { draftID: "dynamic_recovery_draft" })
    const href = kind === "session" ? stressSessionHref(fixture.sourceID) : stressDraftHref("dynamic_recovery_draft")
    await page.goto(href)
    const input = page.locator('[data-component="prompt-input"][contenteditable="true"]').first()
    await expect(input).toBeVisible()
    await input.fill(`Unsent ${kind} work`)
    await expect(input).toContainText(`Unsent ${kind} work`)
    for (const cycle of [1, 2]) {
      await test.step(`Recover connection ${cycle}`, async () => {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("audit-server-availability", { detail: { online: false } })))
        await expect(page.locator("html")).toHaveAttribute("data-audit-online", "false")
        await expect(input).not.toBeVisible()
        await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"))
        expect(errors).toEqual([])
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("audit-server-availability", { detail: { online: true } })))
        await expect(input).toBeVisible()
        await expect(input).toContainText(`Unsent ${kind} work`)
        await expect(page).toHaveURL(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"))
        expect(errors).toEqual([])
      })
    }
  })
}
