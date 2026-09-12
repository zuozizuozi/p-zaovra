import { expect, test } from "@playwright/test"
import { expectSessionTitle } from "../../utils/waits"
import { fixture } from "./session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressSessionHref,
} from "./timeline-test-helpers"

test("settings keeps a visible exit and Escape dismisses only the top layer", async ({ page }) => {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await page.keyboard.press("Control+Comma")
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await expect(settings).toBeVisible()
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "oc-2"))
  const fontInput = settings.getByRole("textbox").first()
  await fontInput.focus()
  await expect(fontInput).toHaveCSS("outline-style", "none")
  await settings.getByRole("tab", { name: "General", exact: true }).focus()
  await expect(settings.getByRole("tab", { name: "General", exact: true })).not.toHaveCSS("box-shadow", "none")
  const dragStrip = page.locator('[data-component="dialog-window-drag-region"]')
  await expect(dragStrip).toHaveCSS("app-region", "drag")
  await expect(dragStrip).toHaveCSS("pointer-events", "auto")
  await settings.getByRole("button", { name: "English", exact: true }).click()
  await expect(page.getByRole("listbox")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("listbox")).toBeHidden()
  await expect(settings).toBeVisible()
  await expect(settings.getByRole("button", { name: "Close", exact: true })).toBeVisible()
  const panel = settings.locator(".settings-v2-panel:visible")
  await expect(panel).toHaveCSS("scrollbar-width", "thin")
  await panel.hover()
  await page.mouse.wheel(0, 1800)
  await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(settings.getByRole("button", { name: "Close", exact: true })).toBeVisible()
  await settings.getByRole("button", { name: "Close", exact: true }).click()
  await expect(settings).toBeHidden()
  await expect(page.locator('[data-component="dialog-v2"]')).toHaveCount(0)
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  // The provider retains the closing layer for its 100 ms exit lifecycle.
  await page.waitForTimeout(150)
  await page.keyboard.press("Control+Comma")
  await expect(settings).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(settings).toBeHidden()
})

test("session commands keep HTTP session identity aligned without navigation buttons", async ({ page }) => {
  const requested: string[] = []
  await mockStressTimeline(page, {
    onMessages: (input) => {
      if (input.phase === "start") requested.push(input.sessionID)
    },
  })
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await page.keyboard.press("Alt+ArrowDown")
  await expect(page).toHaveURL(new RegExp(`${fixture.targetID}$`))
  await expectSessionTitle(page, fixture.expected.targetTitle)
  expect(requested).toContain(fixture.targetID)
  await expect(page.getByRole("button", { name: "Navigate back", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Navigate forward", exact: true })).toHaveCount(0)
  await page.keyboard.press("Alt+ArrowUp")
  await expectSessionTitle(page, fixture.expected.sourceTitle)
})
