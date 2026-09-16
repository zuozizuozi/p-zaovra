import { test, expect } from "@playwright/test"
import { mockZaovraServer } from "../../utils/mock-server"
import { fixture } from "./session-timeline-stress.fixture"
import { installTimelineSettings, stressSessionHref } from "./timeline-test-helpers"

test("restores an empty session's model after catalog loading and preserves a later user choice", async ({ page }) => {
  const provider = { ...fixture.provider.all[0], id: "nativeaudit", name: "Native audit" }
  const model = { ...Object.values(provider.models)[0], release_date: "" }
  await mockZaovraServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    provider: {
      all: [
        { ...provider, models: { [model.id]: model, chosen: { ...model, id: "chosen", name: "Session-only model" } } },
      ],
      connected: [provider.id],
      default: { [provider.id]: model.id },
    },
    sessions: [
      {
        ...fixture.sessions[0],
        id: "ses_empty_model",
        agent: "build",
        model: { id: "chosen", providerID: provider.id },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/api/model**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    await route.fallback()
  })
  await installTimelineSettings(page)
  await page.goto(stressSessionHref("ses_empty_model"))
  await expect(page.getByRole("button", { name: "Own Key · Session-only model", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Own Key · Session-only model", exact: true }).click()
  await page.getByRole("menuitemradio", { name: model.name, exact: true }).click()
  await expect(page.getByRole("button", { name: `Own Key · ${model.name}`, exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: `Own Key · ${model.name}`, exact: true })).toBeVisible()
})

for (const newLayout of [true, false]) {
  test(`uses a configured nested model ID with new layout ${newLayout}`, async ({ page }) => {
    const provider = { ...fixture.provider.all[0], id: "nativeaudit", name: "Native audit" }
    const model = { ...Object.values(provider.models)[0], release_date: "" }
    await mockZaovraServer(page, {
      directory: fixture.directory,
      project: fixture.project,
      provider: {
        all: [
          {
            ...provider,
            models: {
              [model.id]: model,
              "vendor/nested-model": { ...model, id: "vendor/nested-model", name: "Configured nested model" },
            },
          },
        ],
        connected: [provider.id],
        default: { [provider.id]: model.id },
      },
      sessions: [{ ...fixture.sessions[0], id: "ses_configured_model", agent: "build" }],
      pageMessages: () => ({ items: [] }),
    })
    await page.route("**/config**", async (route) => {
      if (new URL(route.request().url()).pathname !== "/config") return route.fallback()
      await route.fulfill({ json: { model: `${provider.id}/vendor/nested-model` } })
    })
    await page.addInitScript((newLayoutDesigns) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns } }))
    }, newLayout)
    await page.goto(stressSessionHref("ses_configured_model"))
    await expect(page.getByRole("button", { name: "Own Key · Configured nested model", exact: true })).toBeVisible()
  })
}
