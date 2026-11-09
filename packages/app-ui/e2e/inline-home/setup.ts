import type { Page } from "@playwright/test"
import { mockZaovraServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"

export async function setupInlineHome(page: Page, locale: string, theme: string) {
  const base = "http://127.0.0.1:4563"
  const directory = "F:/synthetic-inline-home"
  process.env.PLAYWRIGHT_PORT = "4563"
  process.env.PLAYWRIGHT_SERVER_PORT = "4563"
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.route("**/*", (route) =>
    route.request().isNavigationRequest()
      ? route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="root" style="height:100vh;display:flex"></div><script type="module" src="/e2e/inline-home/desktop.tsx"></script></body>',
        })
      : route.fallback(),
  )
  await page.addInitScript(
    ({ directory, locale, theme }) => {
      localStorage.setItem(
        "zaovra.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, list: [], lastProject: {} }),
      )
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("zaovra.global.dat:language", JSON.stringify({ locale }))
      localStorage.setItem("zaovra-color-scheme", theme)
    },
    { directory, locale, theme },
  )
  const transport = await installSseTransport(page, { server: base })
  await mockZaovraServer(page, {
    directory,
    project: { id: "global", worktree: directory, name: "MCN 工作区", sandboxes: [], time: { created: 1, updated: 1 } },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: "ses_inline",
        projectID: "global",
        directory,
        title: "Existing conversation",
        time: { created: 1, updated: 2 },
      },
      {
        id: "ses_inline_recent",
        projectID: "global",
        directory,
        title: "Recent conversation sentinel",
        time: { created: 1, updated: 3 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    sessionStatus: { ses_inline: { type: "idle" } },
    activeSessions: {},
  })
  await page.goto(base + "/" + btoa(directory) + "/session/ses_inline?locale=" + locale)
  await transport.waitForConnection({ timeout: 15_000 })
}
