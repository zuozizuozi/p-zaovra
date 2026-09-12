import { test, expect } from "@playwright/test"
import { mockStressTimeline, installTimelineSettings, installStressSessionTabs } from "./timeline-test-helpers"

test("custom service exposes all three protocols and uses the selected discovery format", async ({ page }) => {
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  await page.route("https://protocol-test.example/**", (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const headers = request.headers()
    if (headers["x-goog-api-key"]) {
      expect(url.pathname).toBe("/v1beta/models")
      return route.fulfill({
        json: {
          models: [
            { name: "models/gemini-test", displayName: "Gemini test", supportedGenerationMethods: ["generateContent"] },
          ],
        },
      })
    }
    if (headers["x-api-key"]) {
      expect(url.pathname).toBe("/v1/models")
      expect(headers["anthropic-version"]).toBe("2023-06-01")
      return route.fulfill({ json: { data: [{ id: "claude-test", display_name: "Claude test" }] } })
    }
    expect(headers.authorization).toBe("Bearer test-only")
    expect(url.pathname).toBe("/v1/models")
    return route.fulfill({ json: { data: [{ id: "openai-test", name: "OpenAI test" }] } })
  })
  await page.goto("/")
  const welcome = page.getByRole("region", { name: "What will we create today?" })
  await welcome.getByRole("textbox").fill("My draft")
  await welcome.getByRole("button", { name: "Continue to session" }).click()
  await page.locator('[data-action="prompt-model"]').click()
  await page.getByRole("button", { name: "Own Key", exact: true }).click()
  await page.getByRole("menuitem", { name: "Configure your model service" }).click()
  await page.getByRole("dialog").getByText("Custom model service", { exact: true }).click()
  const dialog = page.getByRole("dialog")
  const protocol = dialog.getByRole("combobox", { name: "API protocol" })
  await expect(protocol.locator("option")).toHaveCount(3)
  await dialog.getByLabel("API key", { exact: true }).fill("test-only")
  for (const [kind, name] of [
    ["openai", "OpenAI test"],
    ["anthropic", "Claude test"],
    ["google", "Gemini test"],
  ]) {
    await protocol.selectOption(kind)
    if (kind === "google")
      await expect(dialog.getByLabel("Base URL", { exact: true })).toHaveValue("https://protocol-test.example/v1beta")
    await expect(dialog.getByRole("checkbox")).toHaveCount(0)
    await dialog.getByLabel("Base URL", { exact: true }).fill("https://protocol-test.example")
    await dialog.getByRole("button", { name: "Fetch models", exact: true }).click()
    await expect(dialog.getByRole("checkbox", { name: new RegExp(name) })).toBeChecked()
    await expect(dialog.getByRole("alert")).toHaveCount(0)
  }
  await page.screenshot({ path: "../../quality/provider-protocol-selector.png" })
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(page.locator('[contenteditable="true"]').first()).toContainText("My draft")
})
