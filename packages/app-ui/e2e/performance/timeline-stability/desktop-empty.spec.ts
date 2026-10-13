import { expect, test } from "@playwright/test"
import { mockZaovraServer } from "../../utils/mock-server"

for (const locale of ["en", "zh"] as const)
  for (const scheme of ["light", "dark"] as const) {
    test(`empty catalog offers setup and dismissal in ${locale} ${scheme}`, async ({ page }, info) => {
      const directory = "C:/Zaovra/H3Empty"
      const draftID = "draft_h3_empty"
      const server = `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
      await mockZaovraServer(page, {
        directory,
        project: {
          id: "proj_h3_empty",
          worktree: directory,
          vcs: "git",
          name: "H3",
          time: { created: 1, updated: 1 },
          sandboxes: [],
        },
        provider: { all: [], connected: [], default: {} },
        sessions: [],
        pageMessages: () => ({ items: [] }),
      })
      await page.addInitScript(
        ({ directory, draftID, server, locale, scheme }) => {
          localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
          localStorage.setItem("zaovra-theme-id", "oc-2")
          localStorage.setItem("zaovra-color-scheme", scheme)
          localStorage.setItem("zaovra.global.dat:language", JSON.stringify({ locale }))
          localStorage.setItem(
            "zaovra.global.dat:server",
            JSON.stringify({
              projects: { local: [{ worktree: directory, expanded: true }] },
              lastProject: { local: directory },
            }),
          )
          localStorage.setItem(
            "zaovra.window.browser.dat:tabs",
            JSON.stringify([{ type: "draft", draftID, server, directory }]),
          )
        },
        { directory, draftID, server, locale, scheme },
      )
      await page.goto(`/new-session?draftId=${draftID}`)
      const banner = page.locator('[data-component="provider-tip"]')
      await expect(banner).toBeVisible()
      await expect(
        banner.getByText(locale === "zh" ? "还没有可用的模型服务" : "No model is available yet", { exact: true }),
      ).toBeVisible()
      await expect(
        banner.getByRole("button", { name: locale === "zh" ? "添加模型服务" : "Add model provider", exact: true }),
      ).toBeVisible()
      await expect(page.getByRole("dialog")).toHaveCount(0)
      await page.screenshot({ path: info.outputPath(`no-model-${locale}-${scheme}.png`) })
      await banner.getByRole("button", { name: locale === "zh" ? "稍后" : "Later", exact: true }).click()
      await expect(banner).toBeHidden()
    })
  }
