import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "./session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressSessionHref,
} from "./timeline-test-helpers"
import { base64Encode } from "@zaovra-ai/core/util/encode"
import { mockZaovraServer } from "../../utils/mock-server"
for (const state of ["stopped", "completed", "loading", "server"] as const) {
  test(`S1 budget PATCH switching A to B ${state} never continues another session`, async ({ page }, info) => {
    test.setTimeout(20000)
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const responses: { url: string; status: number }[] = []
    page.on("response", (response) => {
      if (response.url().includes("/session/")) responses.push({ url: response.url(), status: response.status() })
    })
    const sourceID = fixture.sourceID
    const otherID = state === "server" ? sourceID : fixture.targetID
    const serverB = `http://localhost:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4517"}`
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const outcomeGate = Promise.withResolvers<void>()
    const recoveries: string[] = []
    await mockStressTimeline(page)
    if (state === "server")
      await mockZaovraServer(page, {
        origin: serverB,
        provider: fixture.provider,
        directory: fixture.directory,
        project: fixture.project,
        sessions: fixture.sessions,
        pageMessages,
      })
    await installTimelineSettings(page)
    await installStressSessionTabs(page)
    if (state === "server")
      await page.addInitScript((serverB) => {
        const key = "zaovra.global.dat:server"
        const value = JSON.parse(localStorage.getItem(key) ?? "{}")
        localStorage.setItem(key, JSON.stringify({ ...value, list: [serverB] }))
      }, serverB)
    await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
    await page.route("**/api/session/*/budget*", (route) =>
      route.fulfill({
        json: {
          data: {
            limits: { tokens: 30000000, durationMs: 43200000 },
            used: { tokens: 1, durationMs: 1 },
            unreported: 0,
          },
        },
      }),
    )
    await page.route("**/api/session/*/outcome*", async (route) => {
      const isOther =
        state === "server" ? new URL(route.request().url()).origin === serverB : route.request().url().includes(otherID)
      if (isOther && state === "loading") await outcomeGate.promise
      await route.fulfill({
        json: {
          data: {
            state: isOther && state === "completed" ? "completed_unverified" : "stopped",
            runtime: "stopped",
            verification: "unverified",
            messageID: isOther ? "msg_budget_other" : fixture.expected.sourceMessageIDs.at(-1),
            outcomeUnknown: false,
            checks: [],
            missing: [],
            termination: { category: "budget", message: "Budget reached" },
          },
        },
      })
    })
    await page.route("**/api/session/*/recover", async (route) => {
      recoveries.push(route.request().url())
      await route.fulfill({ json: { data: {} } })
    })
    await page.route(`**/api/session/${sourceID}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback()
      started.resolve()
      await gate.promise
      await route.fulfill({ json: { data: {} } })
    })
    await page.goto(stressSessionHref(sourceID))
    await expect(page.locator('[data-component="session-termination"]')).toBeVisible()
    await page.locator('[data-component="session-budget"] > summary').click()
    await page.getByLabel("Total tokens", { exact: true }).fill("40000000")
    await page.getByRole("button", { name: "Apply limits and continue", exact: true }).click()
    await started.promise
    const destination =
      state === "server" ? `/server/${base64Encode(serverB)}/session/${otherID}` : stressSessionHref(otherID)
    await page.evaluate((href) => {
      const anchor = document.createElement("a")
      anchor.href = href
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
    }, destination)
    await expect(page).toHaveURL(new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    gate.resolve()
    await expect(page.getByText("Budget updated; session was not continued.", { exact: true })).toBeVisible()
    expect(recoveries).toEqual([])
    await info.attach("browser-errors", { body: JSON.stringify(errors), contentType: "application/json" })
    await info.attach("session-requests", { body: JSON.stringify(responses), contentType: "application/json" })
    outcomeGate.resolve()
    await expect(page.locator('[data-component="session-budget"]')).toBeVisible()
    const details = page.locator('[data-component="session-budget"]')
    if ((await details.getAttribute("open")) === null) await details.locator("summary").click()
    await expect(page.getByLabel("Total tokens", { exact: true })).toHaveValue("30000000")
    expect(errors).toEqual([])
  })
}
