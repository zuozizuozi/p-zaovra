import { expect, test } from "@playwright/test"
import { fixture } from "./session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressDraftHref,
} from "./timeline-test-helpers"

test("new conversation reuses an empty draft without creating a session and preserves typed drafts", async ({
  page,
}) => {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page, { draftID: "retained_draft" })
  const creates: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/session") creates.push(request.url())
  })
  const drafts = () =>
    page.evaluate(
      () =>
        (JSON.parse(localStorage.getItem("zaovra.window.browser.dat:tabs")!) as { type: string }[]).filter(
          (tab) => tab.type === "draft",
        ).length,
    )
  await page.goto(stressDraftHref("retained_draft"))
  const composer = page.locator('[contenteditable="true"]').first()
  await expect(composer).toBeVisible()
  for (let i = 0; i < 5; i++) await page.keyboard.press("Control+n")
  await expect.poll(drafts).toBe(1)
  await composer.fill("Keep this unsent task")
  await page.keyboard.press("Control+n")
  await expect.poll(drafts).toBe(2)
  await expect(composer).toBeEmpty()
  await page.goto(stressDraftHref("retained_draft"))
  await expect(composer).toHaveText("Keep this unsent task")
  expect(creates).toEqual([])
})

test("a restored draft in a missing directory recovers to an available project", async ({ page }) => {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page, { draftID: "missing_directory_draft" })
  await page.addInitScript(() => {
    const key = "zaovra.window.browser.dat:tabs"
    const tabs = JSON.parse(localStorage.getItem(key)!) as { type: string; directory?: string }[]
    for (const tab of tabs) if (tab.type === "draft") tab.directory = "/deleted-project"
    localStorage.setItem(key, JSON.stringify(tabs))
  })
  await page.route("**/api/location*", async (route) => {
    if (
      ![...new URL(route.request().url()).searchParams.values()].some((value) => value.includes("/deleted-project"))
    ) {
      await route.fallback()
      return
    }
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        name: "DirectoryUnavailableError",
        data: { directory: "/deleted-project" },
      }),
    })
  })
  await page.goto(stressDraftHref("missing_directory_draft"))
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tabs = JSON.parse(localStorage.getItem("zaovra.window.browser.dat:tabs")!) as {
          type: string
          directory?: string
        }[]
        return tabs.find((tab) => tab.type === "draft")?.directory
      }),
    )
    .toBe(fixture.directory)
  await page.keyboard.press("Control+n")
  await expect(page.getByText("Directory unavailable", { exact: true })).toHaveCount(0)
})
