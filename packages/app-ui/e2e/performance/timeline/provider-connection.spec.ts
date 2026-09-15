import { test, expect } from "@playwright/test"
import { mockStressTimeline, installTimelineSettings, installStressSessionTabs } from "./timeline-test-helpers"

for (const service of [
  { id: "openrouter", name: "OpenRouter", base: "https://openrouter.ai/api/v1", npm: "@openrouter/ai-sdk-provider" },
  { id: "deepseek", name: "DeepSeek", base: "https://api.deepseek.com/v1", npm: "@ai-sdk/openai-compatible" },
  { id: "openai", name: "OpenAI", base: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
  { id: "anthropic", name: "Anthropic", base: "https://api.anthropic.com/v1", npm: "@ai-sdk/anthropic" },
  { id: "google", name: "Google", base: "https://generativelanguage.googleapis.com/v1beta", npm: "@ai-sdk/google" },
  {
    id: "gateway-example",
    name: "gateway.example",
    base: "https://gateway.example/v2/llm",
    npm: "@ai-sdk/openai-compatible",
  },
]) {
  test(`connects ${service.name} and exposes models after saving the key`, async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await mockStressTimeline(page)
    await installTimelineSettings(page)
    await installStressSessionTabs(page)
    let connected = false
    let connectionAttempts = 0
    let config: Record<string, unknown> = {}
    const requests: string[] = []
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (/config|\/api\/(model|provider|integration)/.test(url.pathname))
        requests.push(
          `${request.method()} ${url.pathname} ${url.search} connected=${connected} configured=${!!config.provider}`,
        )
    })
    const provider = {
      id: service.id,
      name: service.name,
      api: { type: "aisdk", package: service.npm },
    }
    const models = [
      {
        id: "vendor/test",
        providerID: service.id,
        name: "Router test model",
        api: { type: "aisdk", package: service.npm, id: "vendor/test" },
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        request: { headers: {}, body: {} },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 32000, output: 1000 },
      },
    ]
    const other = {
      id: "other-service",
      name: "Other service",
      api: { type: "aisdk", package: "@ai-sdk/openai-compatible" },
    }
    await page.route("**/api/provider**", (route) =>
      route.fulfill({
        json: {
          data:
            new URL(route.request().url()).pathname === `/api/provider/${service.id}`
              ? provider
              : connected
                ? [provider, other]
                : [other],
        },
      }),
    )
    await page.route("**/api/model**", (route) =>
      route.fulfill({
        json: {
          data: [
            ...(connected ? models : []),
            { ...models[0], id: "other-model", providerID: other.id, name: "Other service model" },
          ],
        },
      }),
    )
    await page.route("**/api/integration**", (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith("/connect/key")) {
        expect(route.request().postDataJSON().key).toBe("test-only")
        connectionAttempts++
        if (service.id === "gateway-example" && connectionAttempts === 1)
          return route.fulfill({ status: 503, json: { message: "Temporary credential save failure" } })
        connected = true
        return route.fulfill({ json: { data: {} } })
      }
      const integration = {
        id: service.id,
        name: service.name,
        methods: [{ id: "key", type: "key", label: "API Key" }],
        connections: connected ? [{ id: "test-credential", type: "credential" }] : [],
      }
      return route.fulfill({
        json: {
          data: path.endsWith(`/${service.id}`)
            ? integration
            : service.id === "gateway-example" && !config.provider
              ? []
              : [integration],
        },
      })
    })
    await page.route("**/config*", (route) => {
      if (route.request().method() === "PATCH") config = route.request().postDataJSON()
      // Native V2 providers can be absent from the legacy preferences response.
      // The model selector must trust the authenticated V2 catalog, not this cache.
      return route.fulfill({ json: route.request().method() === "PATCH" ? config : {} })
    })
    await page.route("**/global/dispose*", (route) => route.fulfill({ json: true }))
    await page.route("https://openrouter.ai/api/v1/key", (route) =>
      route.fulfill(
        route.request().headers().authorization === "Bearer invalid-test"
          ? { status: 401, json: { error: "Invalid key" } }
          : { json: { data: {} } },
      ),
    )
    await page.route(`${service.base}/models${service.id === "openrouter" ? "/user" : ""}`, (route) => {
      const headers = route.request().headers()
      if (service.id === "google") {
        expect(headers["x-goog-api-key"]).toBe("test-only")
        return route.fulfill({
          json: {
            models: [
              {
                name: "models/vendor/test",
                displayName: "Router test model",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          },
        })
      }
      if (service.id === "anthropic") expect(headers["x-api-key"]).toBe("test-only")
      else expect(headers.authorization).toBe("Bearer test-only")
      return route.fulfill({ json: { data: [{ id: "vendor/test", name: "Router test model" }] } })
    })
    await page.goto("/")
    const welcome = page.getByRole("region", { name: "What will we create today?" })
    await welcome.getByRole("textbox").fill("Keep this draft")
    await welcome.getByRole("button", { name: "Continue to session" }).click()
    await page.locator('[data-action="prompt-model"]').click()
    await page.getByRole("button", { name: "Own Key", exact: true }).click()
    await page.getByRole("menuitem", { name: "Configure your model service" }).click()
    if (service.id === "gateway-example") {
      await page.getByRole("dialog").getByText("Custom model service", { exact: true }).click()
      await page.getByRole("dialog").getByLabel("Base URL", { exact: true }).fill(service.base)
    } else {
      await page.getByRole("dialog").getByRole("button", { name: service.name, exact: true }).click()
    }
    if (service.id === "openrouter") {
      await page
        .getByRole("dialog")
        .getByLabel(/API key/i)
        .fill("invalid-test")
      await page.getByRole("dialog").getByRole("button", { name: "Continue", exact: true }).click()
      await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible()
      expect(connected).toBe(false)
      expect(config).toEqual({})
    }
    await page
      .getByRole("dialog")
      .getByLabel(/API key/i)
      .fill("test-only")
    if (service.id === "gateway-example") {
      await page.getByRole("dialog").getByRole("button", { name: "Fetch models", exact: true }).click()
      await expect(page.getByRole("dialog").getByRole("checkbox", { name: /Router test model/ })).toBeChecked()
    }
    await page
      .getByRole("dialog")
      .getByRole("button", { name: service.id === "gateway-example" ? "Save configuration" : "Continue", exact: true })
      .click()
    if (service.id === "gateway-example") {
      await expect(page.getByRole("button", { name: "Save configuration", exact: true })).toBeEnabled()
      expect(connected).toBe(false)
      expect(Object.keys((config.provider ?? {}) as Record<string, unknown>)).toEqual([service.id])
      await page.getByRole("button", { name: "Save configuration", exact: true }).click()
    }
    await expect(page.getByRole("dialog")).toHaveCount(0)
    expect(connected).toBe(true)
    expect(config).toMatchObject({ provider: { [service.id]: { whitelist: ["vendor/test"] } } })
    await page.locator('[data-action="prompt-model"]').click()
    await page.getByRole("button", { name: "Own Key", exact: true }).click()
    await expect(
      page.getByRole("menuitemradio", { name: "Router test model", exact: true }),
      JSON.stringify(requests),
    ).toBeVisible()
    await expect(page.getByRole("combobox", { name: "Model service" })).toHaveValue(service.id)
    await expect(page.getByRole("menuitemradio", { name: "Other service model", exact: true })).toHaveCount(0)
    await page.getByRole("combobox", { name: "Model service" }).selectOption(other.id)
    await expect(page.getByRole("menuitemradio", { name: "Other service model", exact: true })).toBeVisible()
    await expect(page.getByRole("menuitemradio", { name: "Router test model", exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test("provider catalog failures stay in the dialog and can be retried", async ({ page }) => {
  test.setTimeout(90000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mockStressTimeline(page)
  await installTimelineSettings(page)
  await installStressSessionTabs(page)
  let failed = true
  await page.route(/\/api\/integration(?:\?|$)/, (route) =>
    route.fulfill(
      failed
        ? { status: 503, json: { message: "Temporarily unavailable" } }
        : { json: { data: [{ id: "openrouter", name: "OpenRouter", methods: [{ type: "key" }], connections: [] }] } },
    ),
  )
  await page.goto("/")
  const welcome = page.getByRole("region", { name: "What will we create today?" })
  await welcome.getByRole("textbox").fill("Preserve draft during retry")
  await welcome.getByRole("button", { name: "Continue to session" }).click()
  await page.locator('[data-action="prompt-model"]').click()
  await page.getByRole("button", { name: "Own Key", exact: true }).click()
  await page.getByRole("menuitem", { name: "Configure your model service" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("alert")).toContainText("Could not load model services", { timeout: 45000 })
  await expect(dialog.getByRole("button", { name: /Custom model service/ })).toBeVisible()
  failed = false
  await dialog.getByRole("button", { name: "Refresh model services" }).click()
  await expect(dialog.getByRole("button", { name: "OpenRouter", exact: true })).toBeVisible()
  await expect(dialog.getByRole("alert")).toHaveCount(0)
  expect(errors).toEqual([])
})
