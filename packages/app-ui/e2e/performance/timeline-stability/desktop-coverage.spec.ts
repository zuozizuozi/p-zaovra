import { expect, test } from "@playwright/test"
import { assistantMessage, session, setupTimeline, textPart, userMessage, userID } from "./fixture"

test("V2 snapshot diff exposes inspect and undo without a legacy user summary", async ({ page }) => {
  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_delivery", "Updated the file")])],
  })
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
  await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
  await page.reload()
  const summary = page.locator('[data-component="session-turn-diffs-group"]')
  await expect(summary).toBeVisible()
  await expect(summary.getByText("index.html", { exact: true })).toBeVisible()
  await expect(summary.getByRole("button", { name: /undo|revert|reset/i })).toBeVisible()
  await summary.getByRole("button", { name: /view changes|inspect/i }).click()
  await expect(summary.locator('[data-slot="session-turn-diff-view"]')).toBeVisible()
})

test("empty authoritative turn diff does not claim a file was changed", async ({ page }) => {
  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_delivery", "No changes needed")])],
  })
  await page.route(`**/api/session/*/message/${userID}/diff*`, (route) => route.fulfill({ json: { data: [] } }))
  await page.route("**/api/session/active", (route) => route.fulfill({ json: { data: {} } }))
  await page.reload()
  await expect(page.getByText("No changes needed", { exact: true })).toBeVisible()
  await expect(page.locator('[data-component="session-turn-diffs-group"]')).toHaveCount(0)
})

test("optional HTML build inspection cannot suspend the workspace", async ({ page }) => {
  await setupTimeline(page, {
    settings: { newLayoutDesigns: true },
    messages: [userMessage(), assistantMessage([textPart("prt_preview", "Preview ready")])],
  })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let inspected = false
  await page.route("**/file/content*", async (route) => {
    inspected = true
    await gate
    await route.fulfill({ json: { type: "text", content: "<html></html>" } })
  })
  try {
    await page.getByRole("button", { name: "View artifacts", exact: true }).click()
    const panel = page.locator('[data-component="artifacts-panel"]')
    await panel.getByRole("textbox").first().fill("index.html")
    await panel.getByRole("button", { name: "Open", exact: true }).click()
    await expect.poll(() => inspected).toBe(true)
    await expect(page.locator('[data-component="prompt-admission"]')).toBeVisible()
    await expect(panel).toBeVisible()
  } finally {
    release()
  }
})

test("Work page supports the same settings shortcut", async ({ page }) => {
  await setupTimeline(page, { settings: { newLayoutDesigns: true } })
  await page.route("**/api/work", (route) => route.fulfill({ json: { data: [] } }))
  await page.goto("/work")
  await expect(page.locator('[data-component="work-page"]')).toBeVisible()
  await page.keyboard.press("Control+Comma")
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible()
})

for (const locale of ["zh", "en"] as const) {
  test(`long titles, paths and code stay within the workspace in ${locale}`, async ({ page }, info) => {
    await page.addInitScript(
      (scheme) => {
        localStorage.setItem("zaovra-theme-id", "oc-2")
        localStorage.setItem("zaovra-color-scheme", scheme)
      },
      locale === "zh" ? "light" : "dark",
    )
    await setupTimeline(page, {
      locale,
      viewport: { width: 1000, height: 760 },
      settings: { newLayoutDesigns: true },
      sessions: [{ ...session(), title: `${session().title} ${"长标题LongTitle".repeat(40)}` }],
      messages: [
        userMessage(),
        assistantMessage([
          textPart(
            "prt_long_code",
            `C:/${"long-directory/".repeat(40)}index.ts\n\n\`\`\`ts\n${Array.from({ length: 200 }, (_, i) => `const line${i} = "${"long-value".repeat(100)}"`).join("\n")}\n\`\`\``,
          ),
        ]),
      ],
    })
    await expect(page.locator("pre").first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.locator('[data-component="prompt-admission"]')).toBeVisible()
    await page.screenshot({ path: info.outputPath(`${locale}-long-content.png`) })
  })
}
