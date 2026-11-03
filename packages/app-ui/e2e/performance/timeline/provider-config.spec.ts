import { test, expect, type Page } from "@playwright/test"
import { mockZaovraServer } from "../../utils/mock-server"
import { fixture, pageMessages } from "./session-timeline-stress.fixture"

async function openCustomProvider(page: Page) {
  await mockZaovraServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    sessions: fixture.sessions,
    pageMessages,
    provider: fixture.provider,
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
  return dialog
}

test("Ant Ling discovery corrects the endpoint, labels ASR, and retains all selected model types", async ({ page }) => {
  const calls: string[] = []
  let saved: Record<string, { options?: { baseURL?: string }; models?: Record<string, unknown> }> = {}
  await page.route("https://api.ant-ling.com/**", async (route) => {
    const path = new URL(route.request().url()).pathname
    calls.push(path)
    if (path === "/v1/models")
      return route.fulfill({ json: { data: [{ id: "Ming-3.0-asr-tiny" }, { id: "Ling-2.5-1T" }] } })
    if (path === "/v1/responses") return route.fulfill({ json: { output: [] } })
    return route.fulfill({ status: 404, json: { error: { message: "No static resource " + path } } })
  })
  const dialog = await openCustomProvider(page)
  await page.route(/\/(?:global\/)?config(?:\?|$)/, async (route) => {
    if (route.request().method() === "PATCH") saved = route.request().postDataJSON().provider
    await route.fulfill({ json: { provider: saved } })
  })
  await dialog
    .getByRole("textbox", { name: "Base URL", exact: true })
    .fill("https://api.ant-ling.com/v1/audio/transcriptions")
  await expect(dialog.getByText(/We will use https:\/\/api.ant-ling.com\/v1 as the base URL/)).toBeVisible()
  await dialog.getByRole("button", { name: "Fetch models", exact: true }).click()
  await expect(dialog.getByRole("textbox", { name: "Base URL", exact: true })).toHaveValue(
    "https://api.ant-ling.com/v1",
  )
  await expect(dialog.getByRole("checkbox", { name: "Ling-2.5-1T", exact: true })).toBeChecked()
  const asr = dialog.getByRole("checkbox", { name: /Ming-3.0-asr-tiny/ })
  await expect(asr).not.toBeChecked()
  await expect(dialog.getByText(/speech recognition · This model cannot be used for chat yet/)).toBeVisible()
  await asr.check()
  await expect(dialog.getByText(/Removed the API endpoint/)).toBeVisible()
  if (process.env.ZAOVRA_CAPTURE_DIR)
    await page.screenshot({ path: process.env.ZAOVRA_CAPTURE_DIR + "/557-after-model-list.png" })
  await dialog.getByRole("button", { name: "Save configuration", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  const provider = Object.values(saved)[0]!
  expect(provider.options?.baseURL).toBe("https://api.ant-ling.com/v1")
  expect(Object.keys(provider.models ?? {})).toEqual(["Ling-2.5-1T", "Ming-3.0-asr-tiny"])
  expect(calls.filter((path) => !path.includes("/api/pricing"))).toEqual(["/v1/models", "/v1/responses"])
})

test("manual Ant Ling ASR is explained and can be retained without any chat protocol request", async ({ page }) => {
  let writes = 0
  let probes = 0
  await page.route("https://api.ant-ling.com/**", async (route) => {
    probes++
    await route.fulfill({ status: 404, json: {} })
  })
  const dialog = await openCustomProvider(page)
  await page.route(/\/(?:global\/)?config(?:\?|$)/, async (route) => {
    if (route.request().method() === "PATCH") writes++
    await route.fulfill({ json: {} })
  })
  await dialog
    .getByRole("textbox", { name: "Base URL", exact: true })
    .fill("https://api.ant-ling.com/v1/audio/transcriptions")
  await dialog.getByRole("button", { name: "Enter models manually" }).click()
  await dialog.getByPlaceholder("model-id", { exact: true }).fill("Ming-3.0-asr-tiny")
  await expect(
    dialog.getByText(
      "This is a speech recognition model. It cannot be used for chat yet; it can be saved for future tool support.",
    ),
  ).toBeVisible()
  if (process.env.ZAOVRA_CAPTURE_DIR)
    await page.screenshot({ path: process.env.ZAOVRA_CAPTURE_DIR + "/557-after-manual-type.png" })
  await dialog.getByRole("button", { name: "Save configuration", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(writes).toBe(1)
  expect(probes).toBe(0)
})

for (const status of [400, 404])
  test(`a corrected endpoint rejected with HTTP ${status} explains the base URL in the error card`, async ({
    page,
  }) => {
    const calls: string[] = []
    await page.route("https://api.ant-ling.com/**", async (route) => {
      calls.push(new URL(route.request().url()).pathname)
      await route.fulfill({ status, json: { error: { message: "fixture only" } } })
    })
    const dialog = await openCustomProvider(page)
    await dialog
      .getByRole("textbox", { name: "Base URL", exact: true })
      .fill("https://api.ant-ling.com/v1/audio/transcriptions")
    await dialog.getByRole("button", { name: "Fetch models", exact: true }).click()
    await expect(dialog.getByRole("alert")).toContainText(
      "The address included an API endpoint and was corrected to https://api.ant-ling.com/v1",
    )
    expect(calls.filter((path) => !path.includes("/api/pricing"))).toEqual(["/v1/models"])
  })

test("an ASR-only catalog stays visible and describes its future tool use", async ({ page }) => {
  await page.route("https://api.ant-ling.com/**", (route) =>
    route.fulfill({ json: { data: [{ id: "Ming-3.0-asr-tiny" }] } }),
  )
  const dialog = await openCustomProvider(page)
  await dialog.getByRole("textbox", { name: "Base URL", exact: true }).fill("https://api.ant-ling.com/v1")
  await dialog.getByRole("button", { name: "Fetch models", exact: true }).click()
  await expect(dialog.getByRole("checkbox", { name: /Ming-3.0-asr-tiny/ })).toBeChecked()
  await expect(dialog.getByText(/speech recognition · This model cannot be used for chat yet/)).toBeVisible()
})

test("an unknown model type can be specified in Advanced and is persisted without a chat probe", async ({ page }) => {
  let probes = 0
  await page.route("https://api.ant-ling.com/**", (route) => {
    probes++
    return route.fulfill({ status: 404 })
  })
  const dialog = await openCustomProvider(page)
  await dialog.getByRole("textbox", { name: "Base URL", exact: true }).fill("https://api.ant-ling.com/v1")
  await dialog.getByRole("button", { name: "Enter models manually" }).click()
  await dialog.getByPlaceholder("model-id", { exact: true }).fill("opaque-model")
  await dialog.getByText("Advanced settings", { exact: true }).click()
  const type = dialog.getByRole("combobox", { name: "opaque-model · Model type", exact: true })
  await expect(type).toHaveValue("auto")
  await type.selectOption("asr")
  await page.route(/\/(?:global\/)?config(?:\?|$)/, (route) => route.fulfill({ json: {} }))
  await dialog.getByRole("button", { name: "Save configuration", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  expect(probes).toBe(0)
  expect(
    await page.evaluate(() =>
      Object.values(localStorage).some((value) => value.includes("opaque-model") && value.includes('"asr"')),
    ),
  ).toBe(true)
})

test("an echoed probe reply is rejected with a model-type hint and never saved as chat", async ({ page }) => {
  let writes = 0
  await page.route("https://api.ant-ling.com/**", (route) =>
    route.fulfill({
      json: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Reply OK" }] }] },
    }),
  )
  const dialog = await openCustomProvider(page)
  await page.route(/\/(?:global\/)?config(?:\?|$)/, (route) => {
    if (route.request().method() === "PATCH") writes++
    return route.fulfill({ json: {} })
  })
  await dialog.getByRole("textbox", { name: "Base URL", exact: true }).fill("https://api.ant-ling.com/v1")
  await dialog.getByRole("button", { name: "Enter models manually" }).click()
  await dialog.getByPlaceholder("model-id", { exact: true }).fill("opaque-model")
  await dialog.getByRole("button", { name: "Save configuration", exact: true }).click()
  await expect(page.getByText(/The model echoed the test input or returned an invalid chat response/)).toBeVisible()
  await expect(dialog).toBeVisible()
  expect(writes).toBe(0)
  await expect(page.getByText("Reply OK", { exact: true })).toHaveCount(0)
  if (process.env.ZAOVRA_CAPTURE_DIR)
    await page.screenshot({ path: process.env.ZAOVRA_CAPTURE_DIR + "/557-invalid-reply.png" })
})

test("configured ASR remains listed and cannot replace a chat selection", async ({ page }) => {
  const provider = {
    all: [
      {
        id: "bailing",
        name: "Bailing",
        models: Object.fromEntries(
          ["Ming-3.0-asr-tiny", "Ling-2.5-1T"].map((id) => [id, { id, name: id, limit: { context: 200000 } }]),
        ),
      },
    ],
    connected: ["bailing"],
    default: { bailing: "Ming-3.0-asr-tiny" },
  }
  await mockZaovraServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    sessions: fixture.sessions,
    pageMessages,
    provider,
  })
  await page.route(/\/(?:global\/)?config(?:\?|$)/, (route) =>
    route.fulfill({ json: { model: "bailing/Ming-3.0-asr-tiny" } }),
  )
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("zaovra.global.dat:language", JSON.stringify({ locale: "en" }))
  })
  let sends = 0
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/session(?:\/|$)/.test(request.url())) sends++
  })
  await page.goto("/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session")
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.fill("keep this draft")
  await page.locator('[data-action="prompt-model"]').click()
  await page.getByRole("menuitemradio").filter({ hasText: "Ling-2.5-1T" }).click()
  await expect(page.locator('[data-action="prompt-model"]')).toContainText("Ling-2.5-1T")
  await page.locator('[data-action="prompt-model"]').click()
  const asr = page.getByRole("menuitemradio").filter({ hasText: "Ming-3.0-asr-tiny" })
  await expect(asr).toContainText("speech recognition")
  await asr.click()
  await expect(page.locator('[data-action="prompt-model"]')).toContainText("Ling-2.5-1T")
  await expect(composer).toContainText("keep this draft")
  expect(sends).toBe(0)
  if (process.env.ZAOVRA_CAPTURE_DIR)
    await page.screenshot({ path: process.env.ZAOVRA_CAPTURE_DIR + "/557-asr-selector.png" })
})
