import { expect, test } from "@playwright/test"
import { assistantMessage, directory, sessionID, setupTimeline, textPart, userID, userMessage } from "./fixture"

for (const locale of ["zh", "en"] as const) {
  test(`H4 tail surfaces remain opaque and readable in ${locale}`, async ({ page }, info) => {
    await page.addInitScript(
      (scheme) => {
        localStorage.setItem("zaovra-theme-id", "oc-2")
        localStorage.setItem("zaovra-color-scheme", scheme)
      },
      locale === "zh" ? "light" : "dark",
    )
    const timeline = await setupTimeline(page, {
      locale,
      settings: { newLayoutDesigns: true },
      messages: [userMessage(), assistantMessage([textPart("prt_tail", "Updated the file")])],
    })
    await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
    await page.route(`**/api/session/*/message/${userID}/diff*`, (route) =>
      route.fulfill({
        json: {
          data: [
            {
              path: "index.html",
              status: "modified",
              additions: 1,
              deletions: 1,
              patch:
                "diff --git a/index.html b/index.html\n--- a/index.html\n+++ b/index.html\n@@ -1 +1 @@\n-before\n+after\n",
            },
          ],
        },
      }),
    )
    await page.reload()
    const card = page.locator('[data-component="session-turn-diffs-group"]')
    await expect(card).toBeVisible()
    await expect(card).toHaveCSS("border-top-style", "solid")
    const inspect = card.getByRole("button", { name: locale === "zh" ? "查看变更" : "Review changes", exact: true })
    await expect(inspect).toHaveAttribute("data-variant", "outline")
    await expect(
      card.getByRole("button", { name: locale === "zh" ? "撤销更改" : "Undo changes", exact: true }),
    ).toBeVisible()
    await inspect.click()
    await expect(card.locator('[data-slot="session-turn-diff-view"]')).toBeVisible()
    await page.screenshot({ path: info.outputPath(`${locale}-changes.png`) })

    await page.keyboard.press("Control+Comma")
    await page.getByRole("tab", { name: locale === "zh" ? "模型服务" : "Model services", exact: true }).click()
    await page.locator('[data-component="custom-provider-section"]').getByRole("button").click()
    const dialog = page.getByRole("dialog").last()
    await expect(dialog.getByPlaceholder("https://api.openai.com/v1")).toBeVisible()
    await expect(dialog).toHaveCSS("opacity", "1")
    await expect(dialog).toHaveCSS("animation-name", "none")
    await expect(dialog).toHaveCSS("background-color", locale === "zh" ? "rgb(255, 255, 255)" : "rgb(35, 34, 40)")
    await expect(page.locator('[data-component="dialog-overlay"]').last()).toHaveCSS(
      "background-color",
      locale === "zh" ? "rgba(20, 16, 30, 0.4)" : "rgba(0, 0, 0, 0.6)",
    )
    await page.screenshot({ path: info.outputPath(`${locale}-provider.png`) })
    await page.keyboard.press("Escape")
    await page.keyboard.press("Escape")

    for (const permission of ["external_directory", "bash", "doom_loop", "custom_unknown"]) {
      await timeline.transport.writeRaw(
        `data: ${JSON.stringify({
          directory,
          payload: {
            id: `evt_tail_${permission}`,
            type: "permission.asked",
            properties: {
              id: `per_${permission}`,
              sessionID,
              permission,
              patterns: ["C:/example/outside.txt"],
              always: [],
              metadata: {},
            },
          },
        })}\n\n`,
      )
      const dock = page.locator('[data-component="dock-prompt"][data-kind="permission"]')
      await expect(dock).toBeVisible()
      await expect(dock.getByText(permission, { exact: true })).toBeHidden()
      if (permission === "external_directory") {
        await expect(
          dock.getByText(locale === "zh" ? "访问项目目录之外的文件" : "Access files outside the project directory", {
            exact: true,
          }),
        ).toBeVisible()
        await page.screenshot({ path: info.outputPath(`${locale}-permission.png`) })
      }
      await dock.getByText(locale === "zh" ? "权限详情" : "Permission details", { exact: true }).click()
      await expect(dock.getByText(permission, { exact: true })).toBeVisible()
      await timeline.transport.writeRaw(
        `data: ${JSON.stringify({
          directory,
          payload: {
            id: `evt_reply_${permission}`,
            type: "permission.replied",
            properties: { sessionID, requestID: `per_${permission}`, reply: "once" },
          },
        })}\n\n`,
      )
      await expect(dock).toBeHidden()
    }
  })
}
