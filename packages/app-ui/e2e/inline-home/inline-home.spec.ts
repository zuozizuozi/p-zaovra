import { expect, test } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"
import { setupInlineHome } from "./setup"

for (const locale of ["zh", "en"])
  for (const theme of ["light", "dark"])
    test(`${locale}/${theme}: project rename keeps its glyph and text position; new draft has no start options`, async ({
      page,
    }) => {
      const root = process.env.QA_INLINE_ROOT!
      await mkdir(root + "/screenshots", { recursive: true })
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      await setupInlineHome(page, locale, theme)
      await expect(page.locator("html")).toHaveAttribute("data-color-scheme", theme)
      const sidebar = page.locator('[data-component="desktop-sidebar-v2"]')
      if (!(await sidebar.isVisible()))
        await page.getByRole("button", { name: locale === "zh" ? "切换侧边栏" : "Toggle sidebar", exact: true }).click()
      await expect(sidebar).toBeVisible()
      const group = sidebar.locator('[data-slot="sidebar-project"]').first()
      const heading = group.locator('[data-slot="project-heading"]')
      const name = group.locator('[data-slot="project-name"]')
      const glyph = heading.locator("button > span").first()
      const original = await name.innerText()
      const before = {
        glyph: await glyph.boundingBox(),
        name: await name.boundingBox(),
        heading: await heading.boundingBox(),
      }
      const open = async () => {
        await heading.click({ button: "right" })
        await page.getByRole("menuitem", { name: locale === "zh" ? "重命名" : "Rename", exact: true }).click()
        await expect(group.locator('[data-action="project-rename"]')).toBeFocused()
      }
      await open()
      const input = group.locator('[data-action="project-rename"]')
      await expect(input).toHaveValue(original)
      const selection = await input.evaluate((el) => {
        if (!(el instanceof HTMLInputElement)) throw new Error("Rename control must be an input")
        return [el.selectionStart, el.selectionEnd, el.value.length]
      })
      expect(selection).toEqual([0, original.length, original.length])
      const editing = {
        glyph: await glyph.boundingBox(),
        input: await input.boundingBox(),
        heading: await heading.boundingBox(),
      }
      await writeFile(
        `${root}/${locale}-${theme}-geometry.json`,
        JSON.stringify({ before, editing, selection }, null, 2),
      )
      expect(editing.glyph).toEqual(before.glyph)
      expect(editing.heading).toEqual(before.heading)
      for (const key of ["x", "y", "width", "height"] as const)
        expect(Math.abs(editing.input![key] - before.name![key]), key).toBeLessThanOrEqual(0.5)
      await page.screenshot({ path: `${root}/screenshots/${locale}-${theme}-rename.png` })
      await input.fill("Cancelled")
      await input.press("Escape")
      await expect(input).toHaveCount(0)
      await expect(name).toHaveText(original)
      await open()
      await input.fill("Renamed 工作区")
      await input.dispatchEvent("compositionstart")
      await input.press("Enter")
      await expect(input).toHaveCount(1)
      await input.dispatchEvent("compositionend")
      await page.waitForTimeout(30)
      await input.press("Enter")
      await expect(input).toHaveCount(0)
      await expect(name).toHaveText("Renamed 工作区")
      await open()
      await input.fill("   ")
      await input.press("Enter")
      await expect(input).toHaveCount(0)
      await expect(name).toHaveText("Renamed 工作区")
      await open()
      await input.fill("Blur saved")
      await page.locator('[data-component="desktop-sidebar-v2"]').click({ position: { x: 5, y: 5 } })
      await expect(input).toHaveCount(0)
      await expect(name).toHaveText("Blur saved")
      await group.locator('button[data-slot="project-action"]').first().click()
      await expect(page.locator('[data-slot="new-session-task"]')).toBeVisible()
      await expect(page.locator('[data-component="session-start-options"]')).toHaveCount(0)
      await expect(page.locator('[data-slot="new-session-task"] [contenteditable="true"]')).toBeVisible()
      await page.screenshot({ path: `${root}/screenshots/${locale}-${theme}-home.png` })
      await page.locator("[data-inline-release]").click()
      const confirm = page.locator('[data-release-notes-actions] [data-variant="primary"]')
      await expect(confirm).toBeVisible()
      const mouseFocus = await confirm.evaluate((el) => ({
        focused: document.activeElement === el,
        visible: el.matches(":focus-visible"),
        outline: getComputedStyle(el).outlineWidth,
        outlineStyle: getComputedStyle(el).outlineStyle,
      }))
      await writeFile(`${root}/${locale}-${theme}-release-focus.json`, JSON.stringify({ mouseFocus }, null, 2))
      await page.screenshot({ path: `${root}/screenshots/${locale}-${theme}-release-mouse.png` })
      expect(mouseFocus.focused).toBe(false)
      expect(mouseFocus.outlineStyle).toBe("none")
      for (let index = 0; index < 6 && !(await confirm.evaluate((el) => document.activeElement === el)); index++)
        await page.keyboard.press("Tab")
      await expect(confirm).toBeFocused()
      expect(await confirm.evaluate((el) => el.matches(":focus-visible"))).toBe(true)
      expect(await confirm.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none")
      expect(await confirm.evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth))).toBeGreaterThan(0)
      await page.screenshot({ path: `${root}/screenshots/${locale}-${theme}-release-keyboard.png` })
      await page.keyboard.press("Enter")
      await expect(confirm).toHaveCount(0)
      await writeFile(
        `${root}/${locale}-${theme}.json`,
        JSON.stringify({ original, before, editing, selection, errors }, null, 2),
      )
      expect(errors).toEqual([])
    })

test("startup release focus does not draw a button ring; Tab still exposes keyboard focus", async ({ page }) => {
  const root = process.env.QA_INLINE_ROOT!
  await setupInlineHome(page, "zh", "light")
  await page.goto("http://127.0.0.1:4563/?locale=zh")
  await expect(page.locator('[data-slot="new-session-task"]')).toBeVisible()
  await page.locator("[data-inline-release]").evaluate((el) => (el as HTMLButtonElement).click())
  const confirm = page.locator('[data-release-notes-actions] [data-variant="primary"]')
  await expect(confirm).toBeVisible()
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  const focus = await confirm.evaluate((el) => ({
    focused: document.activeElement === el,
    visible: el.matches(":focus-visible"),
    outline: getComputedStyle(el).outline,
    target: document.activeElement?.outerHTML.slice(0, 250),
  }))
  await writeFile(`${root}/${process.env.QA_INLINE_RUN}-startup-focus.json`, JSON.stringify(focus, null, 2))
  await page.screenshot({ path: `${root}/screenshots/${process.env.QA_INLINE_RUN}-startup-release.png` })
  expect(focus.focused).toBe(false)
  expect(focus.visible).toBe(false)
  await expect(page.locator("[data-release-notes]")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(confirm).toHaveCount(0)
})
