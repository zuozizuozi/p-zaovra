import type { Page } from "@playwright/test"
import type { Config } from "@zaovra-ai/sdk/v2/types"
import { mockStressTimeline, installStressSessionTabs, stressSessionHref } from "./timeline-test-helpers"

export async function savedProvider766(page: Page, newLayout = true, locale = "en") {
  // The production clock has retired the legacy layout. Exercise that retained
  // renderer at its supported historical date without changing product flags.
  if (!newLayout) await page.clock.setFixedTime(new Date("2026-09-01T08:00:00Z"))
  const state = {
    config: {
      model: "api-gravitex-ai/deepseek-v4.1-flash",
      provider: {
        "api-gravitex-ai": {
          name: "万引",
          npm: "@ai-sdk/openai",
          options: { baseURL: "https://api.gravitex.ai", headers: { "X-Saved": "synthetic" } },
          whitelist: ["auto", "deepseek-v4.1-flash"],
          models: {
            auto: {},
            "deepseek-v4.1-flash": { name: "DeepSeek", provider: { npm: "@ai-sdk/openai-compatible" }, variants: {} },
          },
        },
      },
    } as Config,
    writes: [] as Config[],
    discoveries: 0,
    failed: false,
    errors: [] as string[],
  }
  page.on("pageerror", (error) => state.errors.push(error.message))
  await page.route("https://**", (route) => route.abort())
  await mockStressTimeline(page)
  await page.route("**/pty/shells*", (route) => route.fulfill({ json: [] }))
  await installStressSessionTabs(page)
  await page.addInitScript(
    ({ newLayout, locale }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: newLayout } }))
      localStorage.setItem("language.v1", JSON.stringify({ locale }))
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.18.3" }))
      document.cookie = `zaovra_locale=${locale}; Path=/`
    },
    { newLayout, locale },
  )
  const id = "api-gravitex-ai"
  const provider = {
    id,
    name: "万引",
    api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://api.gravitex.ai" },
    request: { headers: {}, body: {} },
  }
  await page.route("**/api/provider**", (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/models")) {
      state.discoveries++
      return route.fulfill({
        status: state.failed ? 503 : 200,
        json: state.failed
          ? { message: "unavailable" }
          : {
              data: [
                { id: "auto", name: "Auto" },
                { id: "deepseek-v4.1-flash", name: "DeepSeek upstream" },
                { id: "gpt-6-luna", name: "GPT-6 Luna" },
              ],
            },
      })
    }
    return route.fulfill({ json: { data: path === "/api/provider" ? [provider] : provider } })
  })
  await page.route("**/api/model**", (route) =>
    route.fulfill({
      json: {
        data: Object.entries(state.config.provider?.[id]?.models ?? {}).map(([modelID, model]) => ({
          id: modelID,
          providerID: id,
          name: model.name ?? modelID,
          api: { type: "aisdk", package: model.provider?.npm ?? "@ai-sdk/openai", id: modelID },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          request: { headers: {}, body: {} },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 32000, output: 1000 },
        })),
      },
    }),
  )
  await page.route("**/api/integration**", (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id,
            name: "万引",
            methods: [{ type: "key", label: "API key" }],
            connections: [{ type: "credential", id: "synthetic-credential" }],
          },
        ],
      },
    }),
  )
  await page.route(/\/(?:global\/)?config(?:\?|$)/, (route) => {
    if (route.request().method() === "PATCH") {
      const patch: Config = route.request().postDataJSON()
      state.writes.push(patch)
      state.config = { ...state.config, ...patch, provider: { ...state.config.provider, ...patch.provider } }
    }
    return route.fulfill({ json: state.config })
  })
  await page.goto(stressSessionHref("ses_smoke_source"))
  return state
}
