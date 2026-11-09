import { expect, type Page } from "@playwright/test"
import { mockZaovraServer } from "../../utils/mock-server"
import {
  assistantMessage,
  directory,
  project,
  provider,
  session,
  sessionID,
  setupTimeline,
  textPart,
  userMessage,
  userText,
} from "./fixture"

export function ownershipHistory790() {
  return Array.from({ length: 60 }, (_, index) => {
    const key = String(index).padStart(4, "0")
    const user = "msg_0" + key + "_history_a_user"
    return [
      userMessage(
        [
          userText("790 long conversation input " + key, { id: "prt_" + key + "_user_text" }),
          ...(index % 5
            ? []
            : [
                {
                  id: "prt_" + key + "_image",
                  type: "file" as const,
                  filename: "diagram.svg",
                  mime: "image/svg+xml",
                  url:
                    "data:image/svg+xml," +
                    encodeURIComponent(
                      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#347b82"/></svg>',
                    ),
                },
                ...["notes.pdf", "slides.pptx", "sheet.xlsx"].map((filename, item) => ({
                  id: "prt_" + key + "_file_" + item,
                  type: "file" as const,
                  filename,
                  mime: "application/octet-stream",
                  url: "data:text/plain;base64,NzkwIGZpeHR1cmU=",
                })),
              ]),
        ],
        { id: user, created: 1690000000000 + index * 10000 },
      ),
      assistantMessage(
        [
          textPart(
            "prt_" + key + "_long",
            "## Controlled section " +
              key +
              "\n\n" +
              Array.from(
                { length: 28 },
                (_, paragraph) =>
                  "Paragraph " +
                  paragraph +
                  " for row " +
                  key +
                  ". Long text and repeated measured geometry provide a realistic historical reading surface.",
              ).join("\n\n"),
          ),
        ],
        {
          id: "msg_0" + key + "_history_b_assistant",
          parentID: user,
          created: 1690000001000 + index * 10000,
          completed: index !== 0,
        },
      ),
    ]
  }).flat()
}

export async function verifyReading790(page: Page) {
  const timeline = await setupTimeline(page, {
    messages: ownershipHistory790(),
    v2ToolUpdates: true,
    locale: "en",
    reducedMotion: true,
    viewport: { width: 1400, height: 900 },
  })
  const root = page.locator(".scroll-view__viewport").filter({ has: page.locator("[data-timeline-row]") })
  await timeline.settle(8)
  await page.mouse.move(1000, 420)
  await page.mouse.wheel(0, -2200)
  await timeline.settle(3)
  await page.setViewportSize({ width: 700, height: 900 })
  await timeline.settle(5)
  await page.mouse.move(480, 400)
  await page.mouse.wheel(0, -20)
  await timeline.settle(1)
  const row = page.locator('[data-timeline-key="user-message:msg_00055_history_a_user"]')
  const before = { top: await root.evaluate((element) => element.scrollTop), height: (await row.boundingBox())!.height }
  await page.setViewportSize({ width: 1400, height: 900 })
  await timeline.settle(5)
  const after = { top: await root.evaluate((element) => element.scrollTop), height: (await row.boundingBox())!.height }
  expect(before.height).toBeGreaterThan(after.height)
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
  await root.focus()
  const keyboard = await root.evaluate((element) => element.scrollTop)
  await root.press("PageUp")
  await timeline.settle(10)
  expect(await root.evaluate((element) => element.scrollTop)).toBeLessThan(keyboard)
  // Native PageUp is smooth: wait until it stops and the existing gesture window expires.
  await root.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        let previous = element.scrollTop
        let stable = performance.now()
        const sample = () => {
          if (element.scrollTop !== previous) stable = performance.now()
          previous = element.scrollTop
          if (performance.now() - stable >= 300) return resolve()
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      }),
  )
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click()
  await expect
    .poll(() => root.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(1)
  return { before, after, keyboard }
}

export async function verifyPrepend790(page: Page) {
  const messages = ownershipHistory790()
  const timeline = await setupTimeline(page, { messages, v2ToolUpdates: true, locale: "en", reducedMotion: true })
  const gate = Promise.withResolvers<void>()
  const requests: string[] = []
  await mockZaovraServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    sessionStatus: { [sessionID]: { type: "idle" } },
    activeSessions: {},
    beforeMessagesResponse: async ({ before }) => {
      if (!before) return
      requests.push(before)
      await gate.promise
    },
    pageMessages: (_id, _limit, before) =>
      before ? { items: messages.slice(0, 20) } : { items: messages.slice(20), cursor: messages[20]!.info.id },
  })
  try {
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-timeline-key]").first()).toBeAttached()
    await timeline.settle(10)
    await page.mouse.move(1000, 420)
    await page.mouse.wheel(0, -800)
    await timeline.settle(8)
    await page.mouse.wheel(0, -60000)
    await expect.poll(() => requests.length).toBe(1)
    await timeline.settle(5)
    const root = page.locator(".scroll-view__viewport").filter({ has: page.locator("[data-timeline-row]") })
    const anchor = page.locator('[data-timeline-key="user-message:msg_00010_history_a_user"]')
    const before = (await anchor.boundingBox())!.y - (await root.boundingBox())!.y
    gate.resolve()
    await timeline.settle(45)
    const after = (await anchor.boundingBox())!.y - (await root.boundingBox())!.y
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1)
    expect(await root.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    return { before, after, requests }
  } finally {
    gate.resolve()
  }
}
