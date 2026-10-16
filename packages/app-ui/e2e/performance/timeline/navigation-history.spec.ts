import { expect, test } from "@playwright/test"
import { expectSessionTitle } from "../../utils/waits"
import { fixture } from "./session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressSessionHref,
} from "./timeline-test-helpers"

for (const entry of ["home", "sidebar", "shortcut", "legacy", "reuse"] as const) {
  for (const typed of entry === "reuse" ? [false] : [false, true]) {
    test(`history back and forward after ${entry}, typed=${typed}`, async ({ page }, info) => {
      await mockStressTimeline(page)
      await installTimelineSettings(page)
      await installStressSessionTabs(page, entry === "reuse" ? { draftID: "retained_empty" } : undefined)
      const source = stressSessionHref(fixture.sourceID)
      const started = Date.now()
      await page.goto(source)
      await expectSessionTitle(page, fixture.expected.sourceTitle)
      await info.attach("production-navigation-baseline", {
        body: JSON.stringify({ firstSessionReadyMs: Date.now() - started }),
        contentType: "application/json",
      })
      if (entry === "home" || entry === "reuse")
        await page.locator('[data-component="desktop-rail"]').getByRole("button").first().click()
      if (entry === "sidebar" && !(await page.locator('[data-component="desktop-sidebar-v2"]').isVisible()))
        await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
      if (entry === "sidebar")
        await page
          .locator('[data-component="desktop-sidebar-v2"]')
          .getByRole("button", { name: "New session", exact: true })
          .first()
          .click()
      if (entry === "shortcut") await page.keyboard.press("Control+n")
      if (entry === "legacy")
        await page.evaluate(
          (path) => {
            const link = document.createElement("a")
            link.href = path
            document.body.append(link)
            link.click()
            link.remove()
          },
          `/${btoa(fixture.directory).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}/session`,
        )
      await expect(page).toHaveURL(/\/new-session\?draftId=/)
      const draft = page.url()
      const editor = page.locator('[contenteditable="true"]').first()
      await expect(editor).toBeVisible()
      if (typed) await editor.fill("UNSENT_HISTORY_REQUIREMENT")
      await page.goBack()
      await expect(page).toHaveURL(new URL(source, draft).href)
      await expectSessionTitle(page, fixture.expected.sourceTitle)
      await page.goForward()
      await expect(page).toHaveURL(draft)
      await expect(editor).toBeVisible()
      if (typed) await expect(editor).toContainText("UNSENT_HISTORY_REQUIREMENT")
      if (!typed) await expect(editor).toBeEmpty()
    })
  }
}
