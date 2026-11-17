import { expect, test } from "@playwright/test"
import { assistantMessage, partUpdated, setupTimeline, toolPart, userMessage } from "./fixture"

for (const width of [900, 1280]) {
  test(`background command labels remain readable at ${width}px`, async ({ page }, info) => {
    const part = (index: number, state: "running" | "completed") =>
      toolPart(
        `prt_background_label_${index}`,
        "bash",
        "completed",
        {
          command: `node -e "console.log('${"long-command-content-".repeat(20)}${index}')"`,
          run_in_background: true,
        },
        { metadata: { zaovraBackgroundState: state }, output: "Background command started" },
      )
    const timeline = await setupTimeline(page, {
      locale: "zh",
      viewport: { width, height: 900 },
      messages: [userMessage(), assistantMessage([0, 1, 2].map((index) => part(index, "running")))],
      v2ToolUpdates: true,
    })
    const heading = page.locator('[data-component="turn-process-summary"] button')
    await expect(heading).toHaveAttribute("aria-expanded", "false")
    await heading.click()
    const group = page.locator('[data-component="process-tool-group"]')
    await group.locator(":scope > summary").click()
    for (const state of ["running", "completed"] as const) {
      if (state === "completed") for (const index of [2, 0, 1]) await timeline.send(partUpdated(part(index, state)))
      const labels = group.locator('[data-slot="background-command-state"]')
      await expect(labels).toHaveCount(3)
      for (const label of await labels.all())
        await expect(label).toHaveText(state === "running" ? "后台运行中" : "后台已结束")
      await page.screenshot({ path: info.outputPath(`${state}.png`) })
      for (const label of await labels.all()) {
        const bounds = await label.evaluate((element) => {
          const trigger = element.closest('[data-slot="collapsible-trigger"]')!
          const title = trigger.querySelector('[data-slot="basic-tool-tool-title"]')!
          const range = document.createRange()
          range.selectNodeContents(element)
          const rect = element.getBoundingClientRect(),
            outer = trigger.getBoundingClientRect(),
            titleRect = title.getBoundingClientRect()
          return {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            outerTop: outer.top,
            outerBottom: outer.bottom,
            outerLeft: outer.left,
            outerRight: outer.right,
            titleTop: titleRect.top,
            titleBottom: titleRect.bottom,
            textLines: new Set([...range.getClientRects()].map((line) => line.top)).size,
          }
        })
        expect(bounds.textLines, "background state remains a single readable line").toBe(1)
        expect(bounds.top).toBeGreaterThanOrEqual(bounds.outerTop - 1)
        expect(bounds.bottom).toBeLessThanOrEqual(bounds.outerBottom + 1)
        expect(bounds.left).toBeGreaterThanOrEqual(bounds.outerLeft)
        expect(bounds.right).toBeLessThanOrEqual(bounds.outerRight)
        expect(bounds.titleTop).toBeGreaterThanOrEqual(bounds.outerTop - 1)
        expect(bounds.titleBottom).toBeLessThanOrEqual(bounds.outerBottom + 1)
      }
    }
    const command = group.locator('[data-slot="collapsible-trigger"]').first()
    await command.click()
    await expect(group.locator('[data-slot="bash-pre"]').first()).toContainText("long-command-content-")
    await command.click()
    await expect(command).toHaveAttribute("aria-expanded", "false")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
