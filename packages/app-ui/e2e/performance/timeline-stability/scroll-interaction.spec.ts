import { expect, test, type Page } from "@playwright/test"
import {
  defineVisualRegions,
  reportVisualStability,
  startVisualProbe,
  stopVisualProbe,
  visualPlan,
} from "../../utils/visual-stability"
import {
  assistantMessage,
  partUpdated,
  setupTimeline,
  shell,
  sessionID,
  textPart,
  userMessage,
  userID,
  type TimelineMessage,
} from "./fixture"

test("jump to latest overrides a just-finished wheel gesture without waiting for another event", async ({ page }) => {
  await setupTimeline(page, {
    messages: history(20),
    cpuRate: 4,
    reducedMotion: true,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(400)
  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -180 }))
    element.scrollTop -= 180
  })
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeGreaterThan(80)
  // Deliver the final wheel and the explicit resume in the same browser task,
  // so slow CI cannot accidentally age out the gesture guard before the click.
  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1 }))
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Jump to latest"]')
    if (!button) throw new Error("Missing jump control")
    button.click()
  })
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(2)
})

test("does not reverse visible rows when the user wheels during shell remeasurement", async ({ page }, testInfo) => {
  const shellID = "prt_wheel_01_shell"
  const followingID = "prt_wheel_02_following"
  const timeline = await setupTimeline(page, {
    v2ToolUpdates: true,
    messages: [
      ...history(12),
      userMessage(),
      assistantMessage([shell(shellID, "running"), textPart(followingID, "Following wheel interaction")], {
        completed: false,
      }),
    ],
    settings: { shellToolPartsExpanded: true },
    cpuRate: 4,
    reducedMotion: true,
    seedHistory: true,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const regions = defineVisualRegions({
    shell: { selector: `[data-timeline-part-id$=":${shellID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: {
      selector: `[data-timeline-part-id$=":${followingID}"]`,
      closest: '[data-timeline-row="AssistantPart"]',
    },
  })
  await openShell(page, shellID)
  await expect(page.locator(`[data-timeline-part-id$=":${shellID}"]`)).toBeVisible()
  await startVisualProbe(page, regions)
  await timeline.send(partUpdated(shell(shellID, "running", lines(30))), 80)
  await expect(page.locator(`[data-timeline-part-id$=":${shellID}"] [data-slot="bash-pre"]`)).toContainText("line 30")
  await scroller.evaluate((element) =>
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -180 })),
  )
  await scroller.evaluate((element) => (element.scrollTop -= 180))
  await timeline.send(partUpdated(shell(shellID, "running", lines(50))), 250)
  await expect(page.locator(`[data-timeline-part-id$=":${shellID}"] [data-slot="bash-pre"]`)).toContainText("line 50")
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(testInfo, "wheel-during-resize", trace, rowPairPlan(regions, 1))
})

test("keeps moving upward while drag-selecting above the timeline", async ({ page }) => {
  await setupTimeline(page, {
    v2ToolUpdates: true,
    messages: history(80),
    viewport: { width: 1400, height: 700 },
    reducedMotion: true,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const text = page.getByText("History 79.", { exact: false })
  await expect(text).toBeVisible()
  await scroller.evaluate((element) => {
    element.dataset.selectionLength = "0"
    document.addEventListener("selectionchange", () => {
      element.dataset.selectionLength = String(
        Math.max(Number(element.dataset.selectionLength), window.getSelection()?.toString().length ?? 0),
      )
    })
  })
  const textBox = await text.boundingBox()
  const scrollBox = await scroller.boundingBox()
  expect(textBox).not.toBeNull()
  expect(scrollBox).not.toBeNull()
  if (!textBox || !scrollBox) return

  await page.mouse.move(textBox.x + textBox.width - 10, textBox.y + textBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(textBox.x + 20, scrollBox.y - 120, { steps: 30 })

  await expect.poll(() => scroller.evaluate((element) => Number(element.dataset.selectionLength))).toBeGreaterThan(0)
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeGreaterThan(500)
  await page.mouse.up()
})

test("does not pull a keyboard-scrolled user during shell remeasurement", async ({ page }, testInfo) => {
  const shellID = "prt_keyboard_01_shell"
  const followingID = "prt_keyboard_02_following"
  const timeline = await setupTimeline(page, {
    v2ToolUpdates: true,
    messages: [
      ...history(12),
      userMessage(),
      assistantMessage([shell(shellID, "running"), textPart(followingID, "Following keyboard interaction")], {
        completed: false,
      }),
    ],
    settings: { shellToolPartsExpanded: true },
    cpuRate: 4,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  await openShell(page, shellID)
  await scroller.focus()
  for (let index = 0; index < 3; index++) {
    await scroller.press("PageUp")
    await page.waitForTimeout(250)
  }
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop), {
      timeout: 20_000,
    })
    .toBeGreaterThan(80)
  await page.waitForFunction(() => {
    const root = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((element) =>
      element.querySelector("[data-timeline-row]"),
    )
    if (!root) return false
    return new Promise<boolean>((resolve) => {
      const top = root.scrollTop
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.abs(root.scrollTop - top) <= 0.5)))
    })
  })
  const anchor = await scroller.evaluate((element) => {
    const view = element.getBoundingClientRect()
    return [...element.querySelectorAll<HTMLElement>("[data-timeline-key]")].find((row) => {
      const rect = row.getBoundingClientRect()
      return rect.top >= view.top + 40 && rect.bottom <= view.bottom - 40
    })?.dataset.timelineKey
  })
  expect(anchor).toBeTruthy()
  const regions = defineVisualRegions({
    anchor: { selector: `[data-timeline-key="${anchor}"]` },
  })
  await startVisualProbe(page, regions)
  const refreshed = page.waitForResponse(
    async (response) =>
      new URL(response.url()).pathname === `/api/session/${sessionID}/message` &&
      response.ok() &&
      JSON.stringify(await response.json()).includes("line 50"),
  )
  await timeline.send(partUpdated(shell(shellID, "running", lines(50))), 400)
  expect(JSON.stringify(await (await refreshed).json())).toContain("line 50")
  await timeline.settle()
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(testInfo, "keyboard-during-resize", trace, anchorPlan(regions))
})

test("tracks keyboard scrolling from a focused timeline descendant", async ({ page }, testInfo) => {
  const shellID = "prt_descendant_keyboard_01_shell"
  const timeline = await setupTimeline(page, {
    v2ToolUpdates: true,
    messages: [...history(12), userMessage(), assistantMessage([shell(shellID, "completed", lines(5))])],
    settings: { shellToolPartsExpanded: false },
    cpuRate: 4,
    reducedMotion: true,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const row = page.locator(`[data-timeline-part-id$=":${shellID}"]`).first()
  const trigger = page.locator(`[data-timeline-part-id$=":${shellID}"] [data-slot="collapsible-trigger"]`)
  await openProcess(page)
  await row.evaluate((element) => element.setAttribute("tabindex", "0"))
  await row.focus()
  for (let index = 0; index < 3; index++) {
    await row.press("PageUp")
    await page.waitForTimeout(250)
  }
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeGreaterThan(5)
  const anchor = await scroller.evaluate((element) => {
    const view = element.getBoundingClientRect()
    return [...element.querySelectorAll<HTMLElement>("[data-timeline-key]")].find((row) => {
      const rect = row.getBoundingClientRect()
      return rect.top >= view.top + 40 && rect.bottom <= view.bottom - 40
    })?.dataset.timelineKey
  })
  expect(anchor).toBeTruthy()
  const regions = defineVisualRegions({
    anchor: { selector: `[data-timeline-key="${anchor}"]` },
  })
  await startVisualProbe(page, regions)
  await trigger.click()
  await page.waitForTimeout(300)
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(testInfo, "descendant-keyboard-resize", trace, anchorPlan(regions))
})

test("does not claim keyboard scrolling owned by a nested scrollable", async ({ page }) => {
  const shellID = "prt_nested_keyboard_shell"
  await setupTimeline(page, {
    v2ToolUpdates: true,
    messages: [userMessage(), assistantMessage([shell(shellID, "completed", lines(50))])],
    settings: { shellToolPartsExpanded: true },
    cpuRate: 4,
    reducedMotion: true,
    seedHistory: true,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const nested = page.locator(`[data-timeline-part-id$=":${shellID}"] [data-scrollable]`)
  await openShell(page, shellID)
  await nested.evaluate((element) => (element.scrollTop = element.scrollHeight))
  await nested.focus()
  await page.waitForFunction(() => {
    const root = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((element) =>
      element.querySelector("[data-timeline-row]"),
    )
    if (!root) return false
    return new Promise<boolean>((resolve) => {
      const top = root.scrollTop
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.abs(root.scrollTop - top) <= 0.5)))
    })
  })
  const before = await scroller.evaluate((element) => element.scrollTop)
  const nestedBefore = await nested.evaluate((element) => element.scrollTop)
  await nested.press("PageUp")
  await page.waitForTimeout(300)
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before)
  expect(await nested.evaluate((element) => element.scrollTop)).toBeLessThan(nestedBefore)

  await nested.evaluate((element) => (element.scrollTop = 0))
  // Keep the nested control mounted while testing which scroller owns its boundary key.
  await scroller.evaluate((element) => (element.scrollTop = Math.max(0, element.scrollTop - 100)))
  await expect(nested).toBeVisible()
  const boundaryBefore = await scroller.evaluate((element) => element.scrollTop)
  expect(boundaryBefore).toBeGreaterThan(0)
  await nested.press("PageUp")
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(boundaryBefore)

  const nonOverflowing = page.locator(`[data-timeline-part-id$=":${shellID}"]`).first()
  await nonOverflowing.evaluate((element) => {
    element.setAttribute("data-scrollable", "")
    element.setAttribute("tabindex", "0")
  })
  await nonOverflowing.focus()
  const nonOverflowBefore = await scroller.evaluate((element) => element.scrollTop)
  await nonOverflowing.press("PageUp")
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(nonOverflowBefore)
})

test("preserves expanded command output after its virtual row leaves and returns", async ({ page }, info) => {
  const shellID = "prt_scroll_return_shell"
  await setupTimeline(page, {
    v2ToolUpdates: true,
    messages: [...history(80), userMessage(), assistantMessage([shell(shellID, "completed", lines(50))])],
    cpuRate: 4,
    reducedMotion: true,
  })
  const started = performance.now()
  await openShell(page, shellID)
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const group = page.locator('[data-component="process-tool-group"]')
  const viewport = await scroller.boundingBox()
  expect(viewport).not.toBeNull()
  await page.mouse.move(viewport!.x + viewport!.width / 2, viewport!.y + 40)
  await page.mouse.wheel(0, -100000)
  await expect(group).toHaveCount(0)
  await page.getByRole("button", { name: /Jump to latest/i }).click()
  await expect(group).toHaveCount(1)
  await info.attach("scroll-return-observation", {
    body: JSON.stringify({
      elapsedMs: performance.now() - started,
      groupOpen: await group.getAttribute("open"),
      outputVisible: await page.locator(`[data-timeline-part-id$=":${shellID}"] [data-slot="bash-scroll"]`).isVisible(),
    }),
    contentType: "application/json",
  })
  await expect(group).toHaveAttribute("open", "")
  await expect(page.locator(`[data-timeline-part-id$=":${shellID}"] [data-slot="bash-scroll"]`)).toBeVisible()
})

test("jump to latest lands on stable final rows after offscreen growth", async ({ page }, testInfo) => {
  const shellID = "prt_jump_01_shell"
  const followingID = "prt_jump_02_following"
  const timeline = await setupTimeline(page, {
    v2ToolUpdates: true,
    messages: [
      ...history(20),
      userMessage(),
      assistantMessage([shell(shellID, "running"), textPart(followingID, "Latest visible row")], { completed: false }),
    ],
    settings: { shellToolPartsExpanded: true },
    cpuRate: 4,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  await openShell(page, shellID)
  await scroller.evaluate(
    (element) => (element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 600)),
  )
  const refreshed = page.waitForResponse(
    async (response) =>
      new URL(response.url()).pathname === `/api/session/${sessionID}/message` &&
      response.ok() &&
      JSON.stringify(await response.json()).includes("line 50"),
  )
  await timeline.send(partUpdated(shell(shellID, "running", lines(50))), 300)
  expect(JSON.stringify(await (await refreshed).json())).toContain("line 50")
  await timeline.settle()
  const regions = defineVisualRegions({
    shell: { selector: `[data-timeline-part-id$=":${shellID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: {
      selector: `[data-timeline-part-id$=":${followingID}"]`,
      closest: '[data-timeline-row="AssistantPart"]',
    },
  })
  await startVisualProbe(page, regions)
  await page.getByRole("button", { name: /Jump to latest/i }).click()
  await expect(page.locator(`[data-timeline-part-id$=":${followingID}"]`)).toBeVisible()
  await expect(page.locator(`[data-timeline-part-id$=":${shellID}"] [data-slot="bash-pre"]`)).toContainText("line 50")
  await page.waitForTimeout(600)
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "jump-latest",
    trace,
    visualPlan(regions, [
      { type: "required", regions: ["shell", "following"] },
      { type: "unique", regions: ["shell", "following"] },
      { type: "opacity", regions: "all" },
      { type: "continuity", regions: "all" },
      { type: "motion", regions: "all", maxPositionReversals: 1 },
      { type: "label-stability", regions: "all" },
      { type: "acquire-bottom-anchor" },
      { type: "flow", regions: ["shell", "following"] },
    ]),
  )
})

test("handles a single row taller than the viewport", async ({ page }, testInfo) => {
  const shellID = "prt_tall_01_shell"
  const followingID = "prt_tall_02_following"
  const timeline = await setupTimeline(page, {
    v2ToolUpdates: true,
    messages: [
      userMessage(),
      assistantMessage([shell(shellID, "running"), textPart(followingID, "After tall row")], { completed: false }),
    ],
    settings: { shellToolPartsExpanded: true },
    // The shell output is capped, so use a viewport shorter than its expanded row.
    // Keep the real geometry assertion below; more output lines alone cannot make it taller.
    viewport: { width: 900, height: 420 },
    cpuRate: 4,
    seedHistory: true,
  })
  await openShell(page, shellID)
  const regions = defineVisualRegions({
    shell: { selector: `[data-timeline-part-id$=":${shellID}"]`, closest: '[data-timeline-row="AssistantPart"]' },
    following: {
      selector: `[data-timeline-part-id$=":${followingID}"]`,
      closest: '[data-timeline-row="AssistantPart"]',
    },
  })
  await startVisualProbe(page, regions)
  await timeline.send(partUpdated(shell(shellID, "completed", lines(100))), 700)
  await expect(page.locator(`[data-timeline-part-id$=":${shellID}"] [data-slot="bash-pre"]`)).toContainText("line 100")
  const dimensions = await page.locator(`[data-timeline-part-id$=":${shellID}"]`).evaluate((element) => {
    const row = element.closest('[data-timeline-row="AssistantPart"]')!
    const viewport = element.closest(".scroll-view__viewport")!
    return { row: row.getBoundingClientRect().height, viewport: viewport.clientHeight }
  })
  expect(dimensions.row).toBeGreaterThan(dimensions.viewport)
  const trace = await stopVisualProbe<keyof typeof regions>(page)
  await reportVisualStability(
    testInfo,
    "taller-than-viewport",
    trace,
    visualPlan(regions, [
      { type: "required", regions: ["shell", "following"] },
      { type: "unique", regions: ["shell", "following"] },
      { type: "stable", regions: ["shell", "following"] },
      { type: "opacity", regions: "all" },
      { type: "continuity", regions: "all" },
      { type: "motion", regions: "all", maxPositionReversals: 0 },
      { type: "label-stability", regions: "all" },
      { type: "preserve-bottom-anchor" },
      { type: "flow", regions: ["shell", "following"] },
    ]),
  )
})

async function openProcess(page: Page) {
  const details = page.locator(
    `[data-timeline-row="AssistantHeading"][data-message-id="${userID}"] [data-component="turn-process-summary"] button`,
  )
  await expect(details).toHaveAttribute("aria-expanded", "false")
  await details.click()
  await expect(details).toHaveAttribute("aria-expanded", "true")
  const group = page.locator('[data-component="process-tool-group"]')
  // Completed commands are grouped; a running command remains an individual row.
  if (await group.count()) {
    await expect(group).toHaveCount(1)
    if ((await group.getAttribute("open")) === null) await group.locator(":scope > summary").click()
    await expect(group).toHaveAttribute("open", "")
  }
}

async function openShell(page: Page, shellID: string) {
  await openProcess(page)
  const tool = page.locator(`[data-timeline-part-id$=":${shellID}"]`)
  const trigger = tool.locator('[data-slot="collapsible-trigger"]')
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click()
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  await expect(tool.locator('[data-slot="bash-scroll"]')).toBeVisible()
}

function history(count: number): TimelineMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const prefix = `msg_${String(index).padStart(4, "0")}_scroll`
    const userID = `${prefix}_a_user`
    return [
      userMessage(undefined, { id: userID, created: 1690000000000 + index * 10_000 }),
      assistantMessage(
        [textPart(`prt_${String(index).padStart(4, "0")}_scroll`, `History ${index}. ${"content ".repeat(30)}`)],
        {
          id: `${prefix}_b_assistant`,
          parentID: userID,
          created: 1690000001000 + index * 10_000,
        },
      ),
    ]
  }).flat()
}

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}

function rowPairPlan(
  regions: Record<"shell" | "following", { selector: string; closest?: string }>,
  maxPositionReversals: number,
) {
  return visualPlan(regions, [
    { type: "required", regions: ["shell", "following"] },
    { type: "unique", regions: ["shell", "following"] },
    { type: "stable", regions: ["shell", "following"] },
    { type: "opacity", regions: "all" },
    { type: "continuity", regions: "all" },
    { type: "motion", regions: "all", maxPositionReversals },
    { type: "label-stability", regions: "all" },
    { type: "flow", regions: ["shell", "following"] },
  ])
}

function anchorPlan(regions: Record<"anchor", { selector: string; closest?: string }>) {
  return visualPlan(regions, [
    { type: "required", regions: ["anchor"] },
    { type: "unique", regions: ["anchor"] },
    { type: "stable", regions: ["anchor"] },
    { type: "fixed", regions: ["anchor"] },
    { type: "opacity", regions: "all" },
    { type: "continuity", regions: "all" },
    { type: "motion", regions: "all", maxPositionReversals: 0 },
    { type: "label-stability", regions: "all" },
  ])
}
