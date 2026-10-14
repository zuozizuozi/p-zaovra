import { expect, test } from "@playwright/test"
import { directory, sessionID, setupTimeline } from "./fixture"

for (const locale of ["zh", "en"] as const) {
  test(`H5 questions support keyboard, custom replies and cancellation in ${locale}`, async ({ page }, info) => {
    await page.addInitScript(
      (scheme) => {
        localStorage.setItem("zaovra-theme-id", "oc-2")
        localStorage.setItem("zaovra-color-scheme", scheme)
      },
      locale === "zh" ? "light" : "dark",
    )
    const timeline = await setupTimeline(page, { locale, settings: { newLayoutDesigns: true } })
    const replies: unknown[] = []
    const rejects: string[] = []
    await page.route("**/api/session/*/question/*/reply", async (route) => {
      replies.push(route.request().postDataJSON())
      await route.fulfill({ json: { data: true } })
    })
    await page.route("**/api/session/*/question/*/reject", async (route) => {
      rejects.push(route.request().url())
      await route.fulfill({ json: { data: true } })
    })
    const options = [
      { label: "Alternative", description: "Use a separate configuration" },
      { label: "Keep defaults (Recommended)", description: "Use the existing project configuration" },
    ]
    const questions = [
      {
        header: "Approach",
        question: locale === "zh" ? "这次使用哪种配置方式？" : "Which configuration should we use?",
        options,
      },
      {
        header: "Checks",
        question: locale === "zh" ? "需要运行哪些检查？" : "Which checks should run?",
        options,
        multiple: true,
      },
      { header: "Notes", question: locale === "zh" ? "还有其他要求吗？" : "Any other requirements?", options },
    ]
    const ask = async (id: string, items = questions) => {
      await timeline.transport.writeRaw(
        `data: ${JSON.stringify({ directory, payload: { id: `evt_${id}`, type: "question.asked", properties: { id, sessionID, questions: items } } })}\n\n`,
      )
      await expect(page.locator(`[data-notification-target="question:${id}"]`)).toBeVisible()
    }
    const clear = async (id: string) => {
      await timeline.transport.writeRaw(
        `data: ${JSON.stringify({ directory, payload: { id: `evt_clear_${id}`, type: "question.rejected", properties: { requestID: id, sessionID } } })}\n\n`,
      )
    }
    await ask("que_h5_multi")
    const card = page.locator('[data-component="session-question-dock"]')
    const choices = card.locator('button[data-slot="question-option"]')
    await expect(page.locator('[data-slot="question-composer"]')).toHaveAttribute("inert", "")
    await expect(page.locator('[data-component="prompt-input-v2"]')).toBeVisible()
    await expect(choices.first()).toContainText("Keep defaults")
    await expect(card.locator('[data-slot="question-recommended"]')).toHaveText(
      locale === "zh" ? "推荐" : "Recommended",
    )
    await choices.first().focus()
    await page.keyboard.press("2")
    await expect(choices.nth(1)).toHaveAttribute("aria-checked", "true")
    await page.keyboard.press("ArrowUp")
    await expect(choices.first()).toBeFocused()
    await page.screenshot({ path: info.outputPath(`${locale}-question.png`) })
    await page.keyboard.press("Enter")
    await expect(card.locator('[data-slot="question-page"]')).toHaveText("2/3")
    await page.keyboard.press("1")
    await page.keyboard.press("2")
    await expect(choices.first()).toHaveAttribute("aria-checked", "true")
    await expect(choices.nth(1)).toHaveAttribute("aria-checked", "true")
    await page.screenshot({ path: info.outputPath(`${locale}-multi.png`) })
    await page.keyboard.press("Enter")
    const custom = card.locator("textarea")
    await custom.fill("保留自定义要求 123")
    await custom.dispatchEvent("keydown", { key: "Enter", isComposing: true })
    expect(replies).toHaveLength(0)
    await page.screenshot({ path: info.outputPath(`${locale}-custom.png`) })
    await custom.press("Enter")
    await expect
      .poll(() => replies)
      .toEqual([
        {
          answers: [
            ["Keep defaults (Recommended)"],
            ["Keep defaults (Recommended)", "Alternative"],
            ["保留自定义要求 123"],
          ],
        },
      ])
    await clear("que_h5_multi")
    await expect(card).toBeHidden()
    await ask("que_h5_skip", questions.slice(0, 1))
    await card.getByRole("button", { name: locale === "zh" ? "跳过" : "Skip", exact: true }).click()
    await expect.poll(() => rejects.length).toBe(1)
    await clear("que_h5_skip")
    await ask("que_h5_escape", questions.slice(0, 1))
    await card.locator("textarea").fill("draft")
    await page.keyboard.press("Escape")
    expect(rejects).toHaveLength(1)
    await expect(choices.first()).toBeFocused()
    await page.keyboard.press("Escape")
    await expect.poll(() => rejects.length).toBe(2)
    await clear("que_h5_escape")
    await ask("que_h5_single", questions.slice(0, 1))
    await choices.first().focus()
    await page.keyboard.press("1")
    await page.keyboard.press("Enter")
    await expect.poll(() => replies.length).toBe(2)
  })
}

test("H5 notifications use session content, cooldown and request focus in the new layout", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["notifications"])
  await page.addInitScript(() => {
    const entries: { title: string; options: NotificationOptions; instance: Notification }[] = []
    Object.assign(window, { h5Notifications: entries, h5Focused: false })
    // Headless Chromium focus and notification grants are simulated OS boundaries.
    Object.defineProperty(document, "hasFocus", {
      value: () => (window as typeof window & { h5Focused: boolean }).h5Focused,
    })
    window.Notification = new Proxy(Notification, {
      get(target, key) {
        return key === "permission" ? "granted" : Reflect.get(target, key, target)
      },
      construct(target, args: [string, NotificationOptions]) {
        const instance = Reflect.construct(target, args)
        entries.push({ title: args[0], options: args[1], instance })
        return instance
      },
    })
  })
  const timeline = await setupTimeline(page, { settings: { newLayoutDesigns: true } })
  expect(await page.evaluate(() => Notification.permission)).toBe("granted")
  const background = await context.newPage()
  await background.goto("about:blank")
  await background.bringToFront()
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
  const events = async (type: string, properties: object) =>
    timeline.transport.writeRaw(
      `data: ${JSON.stringify({ directory, payload: { id: `evt_notice_${Date.now()}`, type, properties } })}\n\n`,
    )
  const question = {
    id: "que_notice",
    sessionID,
    questions: [
      {
        header: "Choice",
        question: "Which configuration should we use?",
        options: [{ label: "Keep defaults", description: "Retain the existing configuration" }],
      },
    ],
  }
  const notifications = () =>
    page.evaluate(() =>
      (
        window as typeof window & { h5Notifications: { title: string; options: NotificationOptions }[] }
      ).h5Notifications.map(({ title, options }) => ({ title, body: options.body })),
    )
  await events("question.asked", question)
  await expect
    .poll(notifications)
    .toEqual([{ title: "Timeline visual stability", body: "Which configuration should we use?" }])
  await events("question.asked", { ...question, id: "que_cooldown" })
  await page.waitForTimeout(150)
  expect(await notifications()).toHaveLength(1)
  await page.evaluate(() => {
    const item = (window as typeof window & { h5Notifications: { instance: Notification }[] }).h5Notifications[0]!
    item.instance.dispatchEvent(new Event("click"))
  })
  await expect(
    page.locator('[data-notification-target="question:que_notice"] button[data-slot="question-option"]').first(),
  ).toBeFocused()
  await events("question.rejected", { sessionID, requestID: "que_notice" })
  await events("question.rejected", { sessionID, requestID: "que_cooldown" })
  await background.bringToFront()
  await events("permission.asked", {
    id: "per_notice",
    sessionID,
    permission: "bash",
    patterns: ["npm install"],
    always: [],
    metadata: {},
  })
  await expect.poll(notifications).toEqual([
    { title: "Timeline visual stability", body: "Which configuration should we use?" },
    { title: "Timeline visual stability", body: "Wants to run npm install" },
  ])
  await page.evaluate(() => {
    const item = (window as typeof window & { h5Notifications: { instance: Notification }[] }).h5Notifications.at(-1)!
    item.instance.dispatchEvent(new Event("click"))
  })
  await expect(page.locator('[data-notification-target="permission:per_notice"] button').first()).toBeFocused()
  await events("permission.replied", { sessionID, requestID: "per_notice", reply: "reject" })
  await page.evaluate(() => Object.assign(window, { h5Focused: true }))
  await page.bringToFront()
  await events("question.asked", { ...question, id: "que_foreground" })
  await expect(page.locator('[data-notification-target="question:que_foreground"]')).toBeVisible()
  expect(await notifications()).toHaveLength(2)
  await background.close()
})
