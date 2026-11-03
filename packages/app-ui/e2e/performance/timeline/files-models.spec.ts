import { test, expect } from "@playwright/test"
import { mockZaovraServer } from "../../utils/mock-server"
import { fixture, pageMessages } from "./session-timeline-stress.fixture"

test("configured models form one keyboard-searchable list with provider badges and no official tab", async ({
  page,
}) => {
  await mockZaovraServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    sessions: fixture.sessions,
    pageMessages,
    provider: {
      all: ["one", "two"].map((id, index) => ({
        id,
        name: index ? "Second service" : "First service",
        models: {
          ["model-" + index]: {
            id: "model-" + index,
            name: index ? "Beta model" : "Alpha model",
            limit: { context: 200000 },
          },
        },
      })),
      connected: ["one", "two"],
      default: {},
    },
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("zaovra.global.dat:language", JSON.stringify({ locale: "en" }))
  })
  await page.goto("/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/ses_smoke_source")
  await page.locator('[data-action="prompt-model"]').click()
  await expect(page.getByRole("menuitemradio")).toHaveCount(2)
  await expect(page.getByRole("menuitemradio").filter({ hasText: "First service" })).toContainText("Alpha model")
  await expect(page.getByRole("menuitemradio").filter({ hasText: "Second service" })).toContainText("Beta model")
  await expect(page.getByRole("button", { name: "Official service", exact: true })).toHaveCount(0)
  await expect(page.getByRole("combobox", { name: "Model service" })).toHaveCount(0)
  const search = page.getByPlaceholder("Search models")
  await search.fill("second service")
  await expect(page.getByRole("menuitemradio")).toHaveCount(1)
  await search.press("Enter")
  await expect(page.locator('[data-action="prompt-model"]')).toContainText("Beta model")
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible()
})

for (const protocol of ["auto", "responses"] as const)
  test(`custom connection reuses an address with ${protocol} protocol`, async ({ page }) => {
    let saved: Record<string, { models?: Record<string, unknown>; whitelist?: string[] }> = {}
    let probes = 0
    const config = {
      provider: {
        existing: {
          name: "Existing service",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://api.example.test/v1" },
          models: { old: { name: "Old model" } },
          whitelist: ["old"],
        },
      },
    }
    await mockZaovraServer(page, {
      directory: fixture.directory,
      project: fixture.project,
      sessions: fixture.sessions,
      pageMessages,
      provider: {
        all: [
          {
            id: "existing",
            name: "Existing service",
            models: { old: { id: "old", name: "Old model", limit: { context: 200000 } } },
          },
        ],
        connected: ["existing"],
        default: {},
      },
    })
    await page.route(/\/(?:global\/)?config(?:\?|$)/, async (route) => {
      if (route.request().method() === "PATCH") {
        saved = route.request().postDataJSON().provider
        await route.fulfill({ json: { ...config, provider: saved } })
        return
      }
      await route.fulfill({ json: config })
    })
    await page.route("https://api.example.test/v1/responses", (route) => {
      probes++
      return route.fulfill({ json: { output: [] } })
    })
    await page.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("zaovra.global.dat:language", JSON.stringify({ locale: "en" }))
    })
    await page.goto("/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/ses_smoke_source")
    await page.locator('[data-action="prompt-model"]').click()
    await page.getByRole("menuitem", { name: "Configure your model service" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByText("Custom", { exact: true }).click()
    await expect(dialog.getByRole("combobox", { name: "API protocol", exact: true })).not.toBeVisible()
    await dialog.getByText("Advanced settings", { exact: true }).click()
    await expect(dialog.getByRole("combobox", { name: "API protocol", exact: true })).toHaveValue("auto")
    if (protocol === "responses")
      await dialog.getByRole("combobox", { name: "API protocol", exact: true }).selectOption("responses")
    await dialog.getByText("Advanced settings", { exact: true }).click()
    await dialog.getByRole("textbox", { name: "Base URL", exact: true }).fill("https://API.EXAMPLE.TEST/v1/responses/")
    await dialog.getByRole("button", { name: "Enter models manually" }).click()
    await dialog.getByPlaceholder("model-id", { exact: true }).fill("new-model")
    await dialog.getByRole("button", { name: "Save configuration" }).click()
    await expect(dialog).not.toBeVisible()
    expect(Object.keys(saved)).toEqual(["existing"])
    expect(saved.existing?.whitelist).toEqual(["old", "new-model"])
    expect(saved.existing?.models).toHaveProperty("old")
    expect(saved.existing?.models).toHaveProperty("new-model")
    expect(probes).toBe(protocol === "auto" ? 1 : 0)
    expect(saved.existing).toHaveProperty("npm", protocol === "auto" ? "@ai-sdk/openai-compatible" : "@ai-sdk/openai")
  })
