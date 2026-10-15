import { expect, test } from "@playwright/test"
import { base64Encode } from "@zaovra-ai/core/util/encode"
import { mockZaovraServer } from "../../utils/mock-server"
import { fixture, pageMessages } from "./session-timeline-stress.fixture"
import { installTimelineSettings } from "./timeline-test-helpers"

test("embedded settings preserve the session and target server B while default remains A", async ({ page }, info) => {
  const port = process.env.PLAYWRIGHT_SERVER_PORT ?? "4592"
  const a = `http://127.0.0.1:${port}`
  const b = `http://localhost:${port}`
  for (const origin of [a, b]) {
    const provider = { ...structuredClone(fixture.provider), connected: ["openai"] }
    provider.all.forEach((item) => {
      item.id = "openai"
      item.name = origin === a ? "Server A Provider" : "Server B Provider"
      Object.values(item.models).forEach((model) => {
        model.name = origin === a ? "Server A Model" : "Server B Model"
      })
    })
    await mockZaovraServer(page, {
      origin,
      provider,
      directory: fixture.directory,
      project: fixture.project,
      sessions: fixture.sessions,
      pageMessages,
    })
  }
  await installTimelineSettings(page)
  await page.addInitScript(
    ({ b }) => {
      localStorage.setItem(
        "zaovra.global.dat:server",
        JSON.stringify({ list: [{ type: "http", displayName: "Server B", http: { url: b } }] }),
      )
    },
    { b },
  )
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  const calls: string[] = []
  page.on("request", (r) => {
    if (/\/api\/(provider|model|integration|usage|permission\/request)/.test(new URL(r.url()).pathname))
      calls.push(r.url())
  })
  const href = `/server/${base64Encode(b)}/session/${fixture.sourceID}`
  await page.goto(href)
  const input = page.locator('[data-component="prompt-input"][contenteditable="true"]').first()
  await expect(input).toBeVisible()
  await input.fill("Keep this draft on B")
  await page.keyboard.press("Control+,")
  const settings = page.locator(".settings-v2-page")
  await expect(settings).toBeVisible()
  await expect(settings.locator('[data-slot="settings-server"]')).toHaveText("Configuring: Server B")
  expect(calls.some((x) => new URL(x).origin === a && x.includes("/api/model"))).toBe(true)
  expect(calls.some((x) => new URL(x).origin === b && x.includes("/api/model"))).toBe(true)
  calls.length = 0
  await settings.getByRole("tab", { name: "Model services", exact: true }).click()
  await expect(settings.getByText("Server B Provider", { exact: true }).first()).toBeVisible()
  await expect(settings.getByText("Server A Provider", { exact: true })).toHaveCount(0)
  await settings.getByRole("tab", { name: "Models", exact: true }).click()
  await expect(settings.getByRole("switch", { name: "Server B Model" }).first()).toBeVisible()
  await expect(settings.getByRole("switch", { name: "Server A Model" })).toHaveCount(0)
  await settings.getByRole("tab", { name: "Usage dashboard", exact: true }).click()
  await expect.poll(() => calls.some((x) => new URL(x).origin === b && x.includes("/api/usage"))).toBe(true)
  await settings.getByRole("tab", { name: "Permissions", exact: true }).click()
  const toggle = settings.locator('[data-action="settings-auto-accept-permissions"]')
  await expect(toggle.getByRole("switch")).toBeEnabled()
  await toggle.locator('[data-slot="switch-control"]').click()
  await expect
    .poll(() => calls.some((x) => new URL(x).origin === b && x.includes("/api/permission/request")))
    .toBe(true)
  expect(calls.every((x) => new URL(x).origin === b)).toBe(true)
  await expect(toggle.getByRole("switch")).toBeChecked()
  await page.screenshot({ path: info.outputPath("settings-server-b.png"), fullPage: true })
  await settings.getByRole("button", { name: "Close", exact: true }).click()
  await expect(settings).toHaveCount(0)
  await expect(input).toContainText("Keep this draft on B")
  await expect(page).toHaveURL(new RegExp(href + "$"))
  expect(errors).toEqual([])
  await info.attach("settings-requests", {
    body: JSON.stringify({ default: a, target: b, calls }, null, 2),
    contentType: "application/json",
  })
})

test("embedded settings omit the target label for one server", async ({ page }) => {
  await mockZaovraServer(page, {
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    sessions: fixture.sessions,
    pageMessages,
  })
  await installTimelineSettings(page)
  await page.goto(
    `/server/${base64Encode(`http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT}`)}/session/${fixture.sourceID}`,
  )
  await expect(page.locator('[data-component="prompt-input"][contenteditable="true"]').first()).toBeVisible()
  await page.keyboard.press("Control+,")
  await expect(page.locator(".settings-v2-page")).toBeVisible()
  await expect(page.locator('[data-slot="settings-server"]')).toHaveCount(0)
})
