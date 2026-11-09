import { test, expect } from "@playwright/test"
import { savedProvider766 } from "./saved-provider766.fixture"
import { writeFile } from "node:fs/promises"

for (const variant of [
  { layout: true, locale: "en", dark: false, width: 1440 },
  { layout: false, locale: "en", dark: false, width: 1440 },
  { layout: true, locale: "zh", dark: true, width: 1440 },
  { layout: true, locale: "en", dark: false, width: 640 },
])
  test(`766 saved service ${JSON.stringify(variant)}`, async ({ page }, info) => {
    await page.setViewportSize({ width: variant.width, height: 960 })
    await page.emulateMedia({ colorScheme: variant.dark ? "dark" : "light" })
    await page.addInitScript(
      (dark) => localStorage.setItem("zaovra-color-scheme", dark ? "dark" : "light"),
      variant.dark,
    )
    const state = await savedProvider766(page, variant.layout, variant.locale)
    page.setDefaultTimeout(7000)
    await expect
      .poll(() => page.locator("body").evaluate((body) => body.hasAttribute("data-new-layout")))
      .toBe(variant.layout)
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", variant.dark ? "dark" : "light")
    await page.locator('[data-action="prompt-model"]').click()
    const own = page.getByRole("button", { name: /^(Own Key|自有 Key)$/ })
    if (await own.isVisible()) await own.click()
    expect(state.discoveries).toBe(0)
    await page.getByRole("button", { name: /^(Refresh models|刷新模型列表)$/ }).click()
    await expect.poll(() => state.discoveries).toBe(1)
    if (!variant.layout) {
      // The retained legacy prompt hides its control during catalog re-fetch.
      await expect.poll(() => state.writes.length).toBe(1)
      await page.locator('[data-action="prompt-model"]').click()
    }
    await expect(page.getByText("GPT-6 Luna", { exact: true }).last()).toBeVisible()
    expect(state.config.model).toBe("api-gravitex-ai/deepseek-v4.1-flash")
    expect(state.config.provider?.["api-gravitex-ai"]?.models?.["deepseek-v4.1-flash"]?.provider?.npm).toBe(
      "@ai-sdk/openai-compatible",
    )
    await page.screenshot({ path: info.outputPath("refresh.png") })
    await page.getByText("GPT-6 Luna", { exact: true }).last().click()
    await page.keyboard.press("Control+,")
    await page.getByRole("tab", { name: /Model services|模型服务/ }).click()
    await page.getByRole("button", { name: /^(Configure models|配置模型)$/ }).click()
    const dialog = page.getByRole("dialog").last()
    await expect(dialog.getByRole("textbox", { name: /Add a model name|补加模型名/ })).toBeVisible()
    const bounds = await dialog.boundingBox()
    expect(bounds && bounds.x >= 0 && bounds.x + bounds.width <= variant.width + 1).toBe(true)
    state.failed = true
    await dialog.getByRole("textbox", { name: /Add a model name|补加模型名/ }).fill("missing-chat-model")
    await dialog.getByRole("button", { name: /^(Save models|保存模型)$/ }).click()
    await expect(dialog.getByRole("status")).toContainText(/Could not fetch|暂未获取/)
    await expect.poll(() => !!state.config.provider?.["api-gravitex-ai"]?.models?.["missing-chat-model"]).toBe(true)
    await expect(dialog.getByRole("alert")).toBeEmpty()
    await page.screenshot({ path: info.outputPath("manual-fallback.png") })
    const writes = state.writes.length
    const discoveries = state.discoveries
    for (const invalid of ["auto", "deepseek-v4.1-flash"]) {
      await dialog.getByRole("textbox", { name: /Add a model name|补加模型名/ }).fill(invalid)
      await dialog.getByRole("button", { name: /^(Save models|保存模型)$/ }).click()
      await expect(dialog.getByRole("alert")).not.toBeEmpty()
      expect(state.writes).toHaveLength(writes)
      expect(state.discoveries).toBe(discoveries)
    }
    await dialog.getByRole("textbox", { name: /Add a model name|补加模型名/ }).fill("not-saved-yet")
    state.failed = false
    await dialog.getByRole("button", { name: /Refresh upstream models|刷新上游模型/ }).click()
    await expect(dialog.getByRole("alert")).toBeEmpty()
    await expect(dialog.getByRole("status")).toContainText(/Models saved|模型已保存/)
    await expect(dialog.getByRole("textbox", { name: /Add a model name|补加模型名/ })).toHaveValue("not-saved-yet")
    expect(state.config.provider?.["api-gravitex-ai"]?.models?.["not-saved-yet"]).toBeUndefined()
    await dialog.getByRole("button", { name: /^(Close|关闭)$/ }).click()
    await page.keyboard.press("Escape")
    await page.locator('[data-action="prompt-model"]').click()
    await expect(page.getByText("missing-chat-model", { exact: true }).last()).toBeVisible()
    await expect(page.getByRole("button", { name: /^Auto\b/ })).toHaveCount(0)
    await expect(page.locator('[data-component="prompt-variant-control"]')).toHaveCount(0)
    expect(state.errors).toEqual([])
    await page.reload()
    await page.locator('[data-action="prompt-model"]').click()
    await expect(page.getByText("missing-chat-model", { exact: true }).last()).toBeVisible()
    await writeFile(info.outputPath("state.json"), JSON.stringify(state, null, 2))
  })
