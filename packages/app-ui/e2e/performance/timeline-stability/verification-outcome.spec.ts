import { expect, test } from "@playwright/test"
import { setupTimeline } from "./fixture"

test("S1 default settings save explicit unlimited and retain finite limits", async ({ page }, info) => {
  await setupTimeline(page, { settings: { newLayoutDesigns: true } })
  const bodies: unknown[] = []
  await page.route("**/global/config", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    bodies.push(route.request().postDataJSON())
    await route.fulfill({ json: route.request().postDataJSON() })
  })
  await page.keyboard.press("Control+,")
  const settings = page.locator('[data-component="settings-session-budget"]')
  await expect(settings).toBeVisible()
  await expect(settings.getByLabel("Total tokens", { exact: true })).toHaveValue("30000000")
  await expect(settings.getByLabel("Total minutes", { exact: true })).toHaveValue("720")
  await settings.screenshot({ path: info.outputPath("default-settings.png") })
  await settings.getByLabel("Total tokens", { exact: true }).fill("")
  await settings.getByLabel("Total minutes", { exact: true }).fill("")
  await settings.getByRole("button", { name: "Save default limits", exact: true }).click()
  await expect.poll(() => bodies.length).toBe(1)
  expect(bodies[0]).toEqual({ session_token_budget: null, session_duration_ms: null })
  await settings.getByLabel("Total tokens", { exact: true }).fill("40000000")
  await settings.getByLabel("Total minutes", { exact: true }).fill("1440")
  await settings.getByRole("button", { name: "Save default limits", exact: true }).click()
  await expect.poll(() => bodies.length).toBe(2)
  expect(bodies[1]).toEqual({ session_token_budget: 40000000, session_duration_ms: 86400000 })
})
