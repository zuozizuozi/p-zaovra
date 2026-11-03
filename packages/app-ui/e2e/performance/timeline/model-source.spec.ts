import { test, expect } from "@playwright/test"
import { mockZaovraServer } from "../../utils/mock-server"
import { fixture, pageMessages } from "./session-timeline-stress.fixture"
import { installTimelineSettings, installStressSessionTabs } from "./timeline-test-helpers"

for (const configured of [false, true]) {
  test(`composer lists configured models and a file-only menu (${configured ? "configured" : "empty"})`, async ({
    page,
  }) => {
    await mockZaovraServer(page, {
      sessions: fixture.sessions,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
      provider: {
        all: [
          ...fixture.provider.all,
          {
            id: "custom",
            name: "My service",
            models: {
              usable: { id: "usable", name: "My model", limit: { context: 200000 } },
              // V2 model.list applies the whitelist before returning the catalog.
            },
          },
        ],
        connected: configured ? ["custom", "zaovra"] : [],
        default: {},
      },
    })
    await page.route(/\/(?:global\/)?config(?:\?|$)/, (route) =>
      route.fulfill({
        json: configured ? { provider: { custom: { whitelist: ["usable"] } }, model: "custom/usable" } : {},
      }),
    )
    await installTimelineSettings(page)
    await installStressSessionTabs(page)
    await page.goto("/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/ses_smoke_source")
    const editor = page.locator('[contenteditable="true"]').first()
    await editor.fill("Keep this draft")
    await expect(editor).toContainText("Keep this draft")
    await page.locator('[data-action="prompt-attach"]').click()
    await expect(page.getByRole("menuitem", { name: /Add files/ })).toBeVisible()
    await expect(page.getByRole("menuitem")).toHaveCount(1)
    const chooser = page.waitForEvent("filechooser")
    await page.getByRole("menuitem", { name: /Add files/ }).click()
    await chooser
    await editor.press("Control+'")
    await expect(page.getByRole("button", { name: "Official service", exact: true })).toHaveCount(0)
    await expect(page.getByRole("combobox", { name: "Model service" })).toHaveCount(0)
    await expect(page.getByText("Unconfigured preset", { exact: true })).toHaveCount(0)
    if (configured) {
      await expect(page.getByRole("menuitemradio").filter({ hasText: "My model" })).toBeVisible()
      await expect(page.getByRole("menuitemradio").filter({ hasText: "My service" })).toBeVisible()
    } else {
      await expect(page.getByText("No configured models. Connect your model service to get started.")).toBeVisible()
    }
    const search = page.getByPlaceholder("Search models")
    await search.focus()
    await search.press("ArrowDown")
    await page.getByRole("menuitem", { name: "Configure your model service" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect(page.getByRole("dialog").getByText("Zaovra", { exact: true })).toHaveCount(0)
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
    await expect(editor).toContainText("Keep this draft")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
