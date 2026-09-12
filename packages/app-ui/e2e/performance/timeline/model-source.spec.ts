import { test, expect } from "@playwright/test"
import { mockZaovraServer } from "../../utils/mock-server"
import { fixture, pageMessages } from "./session-timeline-stress.fixture"
import { installTimelineSettings, installStressSessionTabs } from "./timeline-test-helpers"

for (const configured of [false, true]) {
  test(`composer has two model sources and a file-only menu (${configured ? "configured" : "empty"})`, async ({
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
              ghost: { id: "ghost", name: "Unconfigured preset", limit: { context: 200000 } },
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
    await page.goto("/")
    const welcome = page.getByRole("region", { name: "What will we create today?" })
    await welcome.getByRole("textbox").fill("Keep this draft")
    await welcome.getByRole("button", { name: "Continue to session" }).click()
    const editor = page.locator('[contenteditable="true"]').first()
    await expect(editor).toContainText("Keep this draft")
    await page.locator('[data-action="prompt-attach"]').click()
    await expect(page.getByRole("menuitem", { name: /Add files/ })).toBeVisible()
    await expect(page.getByRole("menuitem")).toHaveCount(1)
    const chooser = page.waitForEvent("filechooser")
    await page.getByRole("menuitem", { name: /Add files/ }).click()
    await chooser
    await editor.press("Control+'")
    await expect(page.getByRole("button", { name: "Own Key", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Official service", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Own Key", exact: true }).click()
    await expect(page.getByText("Unconfigured preset", { exact: true })).toHaveCount(0)
    if (configured) {
      await expect(page.getByRole("menuitemradio", { name: "My model", exact: true })).toBeVisible()
      await page.getByRole("button", { name: "Official service", exact: true }).click()
      await expect(page.getByRole("menuitemradio", { name: "My model", exact: true })).toHaveCount(0)
      await page.getByRole("menuitemradio", { name: "Claude Opus 4.6", exact: true }).click()
      await expect(page.locator('[data-action="prompt-model"]')).toContainText("Official service")
      await page.locator('[data-action="prompt-model"]').click()
      await expect(page.getByRole("button", { name: "Official service", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      )
      await page.getByRole("button", { name: "Own Key", exact: true }).click()
    } else {
      await expect(page.getByText("No configured models. Connect your model service to get started.")).toBeVisible()
      await page.getByRole("button", { name: "Official service", exact: true }).click()
      await expect(
        page.getByText("No official models are available for this account. You can use your own Key."),
      ).toBeVisible()
      await page.getByRole("button", { name: "Own Key", exact: true }).click()
    }
    const search = page.getByPlaceholder("Search models")
    await search.focus()
    await search.press("Shift+Tab")
    await expect(page.getByRole("button", { name: "Official service", exact: true })).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page.getByRole("button", { name: "Official service", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await page.getByRole("button", { name: "Own Key", exact: true }).click()
    await page.screenshot({ path: `../../quality/model-source-${configured ? "configured" : "empty"}.png` })
    await page.getByRole("menuitem", { name: "Configure your model service" }).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await expect(page.getByRole("dialog").getByText("Zaovra", { exact: true })).toHaveCount(0)
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click()
    await expect(editor).toContainText("Keep this draft")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
