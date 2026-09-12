import { expect, test } from "@playwright/test"
import { fixture } from "./session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressSessionHref,
} from "./timeline-test-helpers"

test("editing server credentials in settings updates session requests", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.goto(stressSessionHref(fixture.sourceID))
  const input = page.locator('[data-component="prompt-input"][contenteditable="true"]').first()
  await expect(input).toBeVisible()
  await input.fill("Keep work while editing credentials")
  await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,")
  const settings = page.locator(".settings-v2-dialog")
  await expect(settings).toBeVisible()
  await settings.getByText("Servers", { exact: true }).first().click()
  await settings.locator(".settings-v2-servers-row").first().getByRole("button", { name: "More options" }).click()
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
  const edit = page.locator(".settings-v2-server-dialog")
  await expect(edit).toBeVisible()
  await edit.getByPlaceholder("username", { exact: true }).click()
  await expect(edit.getByPlaceholder("username", { exact: true })).toBeFocused()
  await edit.getByPlaceholder("username", { exact: true }).fill("audit-user")
  await expect(edit.getByPlaceholder("username", { exact: true })).toHaveValue("audit-user")
  await edit.getByPlaceholder("password", { exact: true }).fill("audit-fixture-password")
  await edit.getByRole("button", { name: "Save", exact: true }).click()
  await expect(edit).toHaveCount(0)
  await expect(page.locator('[data-dialog-layer="1"]')).toHaveCount(0)
  expect(errors).toEqual([])
  // DialogProvider retains the closing entry for its 100 ms exit transition.
  await page.waitForTimeout(150)
  await page.keyboard.press("Escape")
  await expect(settings).not.toBeVisible()
  await page.waitForTimeout(150)
  await expect(input).toContainText("Keep work while editing credentials")
  const requests: Array<string | undefined> = []
  page.on("request", (request) => {
    if (request.url().includes(`/session/${fixture.targetID}`)) requests.push(request.headers().authorization)
  })
  await page
    .locator(`[data-slot="titlebar-tabs"] a[href="${stressSessionHref(fixture.targetID)}"]`)
    .first()
    .click()
  await expect
    .poll(() => requests)
    .toContain(`Basic ${Buffer.from("audit-user:audit-fixture-password").toString("base64")}`)
  await expect(page.getByRole("heading", { name: fixture.expected.targetTitle, exact: true })).toBeVisible()
  await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,")
  await settings.getByRole("tab", { name: "Servers", exact: true }).click()
  await settings.locator(".settings-v2-servers-row").first().getByRole("button", { name: "More options" }).click()
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
  await expect(edit.getByPlaceholder("username", { exact: true })).toHaveValue("audit-user")
  await edit.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(edit).toHaveCount(0)
  await page.waitForTimeout(150)
  await settings.getByRole("tab", { name: "General", exact: true }).click()
  await expect(settings.getByRole("tab", { name: "General", exact: true })).toHaveAttribute("aria-selected", "true")

  // A new page shares real persisted storage, but does not rerun the original page's seeding scripts.
  const restored = await page.context().newPage()
  restored.on("pageerror", (error) => errors.push(error.message))
  await mockStressTimeline(restored)
  const restoredAuth: Array<string | undefined> = []
  restored.on("request", (request) => {
    if (request.url().includes(`/session/${fixture.sourceID}`)) restoredAuth.push(request.headers().authorization)
  })
  await restored.goto(stressSessionHref(fixture.sourceID))
  await expect(restored.getByRole("heading", { name: fixture.expected.sourceTitle, exact: true })).toBeVisible()
  await expect
    .poll(() => restoredAuth)
    .toContain(`Basic ${Buffer.from("audit-user:audit-fixture-password").toString("base64")}`)
  await restored.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,")
  const restoredSettings = restored.locator(".settings-v2-dialog")
  await restoredSettings.getByRole("tab", { name: "Servers", exact: true }).click()
  await restoredSettings
    .locator(".settings-v2-servers-row")
    .first()
    .getByRole("button", { name: "More options" })
    .click()
  await restored.getByRole("menuitem", { name: "Edit", exact: true }).click()
  const restoredEdit = restored.locator(".settings-v2-server-dialog")
  await expect(restoredEdit.getByPlaceholder("password", { exact: true })).toHaveValue("audit-fixture-password")
  await restoredEdit.getByPlaceholder("password", { exact: true }).click()
  await restoredEdit.getByPlaceholder("password", { exact: true }).fill("")
  await restoredEdit.getByRole("button", { name: "Save", exact: true }).click()
  await expect(restoredEdit).toHaveCount(0)

  const cleared = await page.context().newPage()
  cleared.on("pageerror", (error) => errors.push(error.message))
  await mockStressTimeline(cleared)
  const clearedAuth: Array<string | undefined> = []
  cleared.on("request", (request) => {
    if (request.url().includes(`/session/${fixture.sourceID}`)) clearedAuth.push(request.headers().authorization)
  })
  await cleared.goto(stressSessionHref(fixture.sourceID))
  await expect(cleared.getByRole("heading", { name: fixture.expected.sourceTitle, exact: true })).toBeVisible()
  await expect.poll(() => clearedAuth.length).toBeGreaterThan(0)
  expect(clearedAuth.every((authorization) => authorization === undefined)).toBe(true)
  await settings.getByRole("tab", { name: "Servers", exact: true }).click()
  await settings.locator(".settings-v2-servers-row").first().getByRole("button", { name: "More options" }).click()
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click()
  await expect(edit.getByPlaceholder("password", { exact: true })).toHaveValue("")
  expect(errors).toEqual([])
})
