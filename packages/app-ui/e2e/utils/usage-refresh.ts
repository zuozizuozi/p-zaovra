import { expect, type Page } from "@playwright/test"
import { mockZaovraServer } from "./mock-server"

export async function usageRefreshScenario(page: Page, baseURL: string) {
  const sessionID = "ses_usage_refresh808"
  const origin = "http://127.0.0.1:4096"
  const directory = "F:/usage-refresh-fixture"
  await mockZaovraServer(page, {
    origin,
    directory,
    project: {
      id: "proj_usage808",
      worktree: directory,
      vcs: "git",
      name: "Usage refresh",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "fixture",
          name: "Fixture",
          models: {
            offline: { id: "offline", name: "Offline", limit: { context: 200000 }, capabilities: { toolcall: true } },
          },
        },
      ],
      connected: ["fixture"],
      default: { providerID: "fixture", modelID: "offline" },
    },
    sessions: [
      {
        id: sessionID,
        projectID: "proj_usage808",
        directory,
        title: "Usage refresh",
        version: "dev",
        time: { created: 1, updated: 1 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
  let total = 0
  let held = false
  let gate = Promise.withResolvers<void>()
  let requested = 0
  const prompts: unknown[] = []
  const totals = () => ({
    input: total,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total,
    calls: total ? 1 : 0,
    unreported: 0,
  })
  await page.route("**/api/usage*", async (route) => {
    requested++
    if (held) await gate.promise
    await route.fulfill({
      json: {
        data: {
          total: totals(),
          own: totals(),
          official: totals(),
          unknown: totals(),
          lastTurn: null,
          models: [],
          updatedAt: 1,
          billing: "unavailable",
        },
      },
    })
  })
  await page.route(/\/api\/session\/[^/]+\/prompt(?:\?|$)/, async (route) => {
    prompts.push(route.request().postDataJSON())
    await route.fulfill({ json: { data: {} } })
  })
  await page.goto(
    new URL("/server/" + Buffer.from(origin).toString("base64url") + "/session/" + sessionID, baseURL).href,
  )
  const composer = page.locator('[data-component="prompt-input-v2"]').first()
  const outer = composer.locator('xpath=ancestor::*[@data-component="prompt-admission"]')
  const send = composer.locator('[data-action="prompt-submit"]')
  const editor = composer.locator('[contenteditable="true"]').first()
  const bar = page.locator(".session-usage-bar")
  await expect(composer).toBeVisible()
  await expect.poll(() => requested).toBeGreaterThan(0)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await expect(bar).toHaveCount(0)
  const empty = await outer.boundingBox()
  if (!empty) throw new Error("Missing empty composer geometry")

  held = true
  let beforeRequests = requested
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(() => requested).toBeGreaterThan(beforeRequests)
  await expect(bar).toHaveCount(0)
  expect(await outer.boundingBox()).toEqual(empty)
  const emptyResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/usage")
  gate.resolve()
  await (await emptyResponse).finished()
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  held = false
  total = 100
  beforeRequests = requested
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(() => requested).toBeGreaterThan(beforeRequests)
  await expect(bar).toHaveText("100 Tokens")
  await editor.fill("Send once while refreshing usage")
  await expect(send).toBeEnabled()
  await page.mouse.move(0, 0)
  const before = { composer: await outer.boundingBox(), send: await send.boundingBox() }
  if (!before.send || !before.composer) throw new Error("Missing populated composer geometry")
  const point = { x: before.send.x + before.send.width / 2, y: before.send.y + before.send.height / 2 }
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  held = true
  gate = Promise.withResolvers<void>()
  beforeRequests = requested
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect.poll(() => requested).toBeGreaterThan(beforeRequests)
  await expect(bar).toHaveText("100 Tokens")
  const pending = { composer: await outer.boundingBox(), send: await send.boundingBox() }
  expect(pending).toEqual(before)
  const frames = await page.evaluate(async () => {
    const result: {
      composer: { x: number; y: number; width: number; height: number }
      send: { x: number; y: number; width: number; height: number }
    }[] = []
    for (let index = 0; index < 12; index++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const composer = document.querySelector('[data-component="prompt-admission"]')!.getBoundingClientRect()
      const send = document.querySelector('[data-action="prompt-submit"]')!.getBoundingClientRect()
      result.push({
        composer: { x: composer.x, y: composer.y, width: composer.width, height: composer.height },
        send: { x: send.x, y: send.y, width: send.width, height: send.height },
      })
    }
    return result
  })
  for (const frame of frames) expect(frame).toEqual(before)
  await page.mouse.up()
  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]).toMatchObject({ prompt: { text: "Send once while refreshing usage" } })
  const during = await bar.textContent()
  total = 250
  held = false
  gate.resolve()
  await expect(bar).toHaveText("250 Tokens")
  await expect(editor).toHaveText("")
  const after = { composer: await outer.boundingBox(), send: await send.boundingBox() }
  expect(after.composer).toEqual(before.composer)
  expect(prompts).toHaveLength(1)
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width)
  expect(after.composer!.x).toBeGreaterThanOrEqual(0)
  expect(after.composer!.y + after.composer!.height).toBeLessThanOrEqual(viewport.height)
  return { empty, before, pending, frames, after, during, prompts, requests: requested, viewport }
}
