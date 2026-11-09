import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { dict } from "../../../ui/src/i18n/zh"
import type { Feedback } from "@zaovra-ai/schema/feedback"
import { openFeedback, openFeedbackSlash } from "../../src/feedback"

const app = await import("../../src/i18n/zh")
const translations: Record<string, string> = { ...app.dict, ...dict }
const language = { locale: () => "zh", t: (key: string) => translations[key] ?? key }
const payloads: Feedback.Snapshot[] = []
const host = { version: "0.1.0", failure: false, capture: "", captures: 0 }
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@solidjs/router", () => ({ useNavigate: () => () => {} }))
mock.module("@/context/command", () => ({ useCommand: () => ({ trigger: () => {} }) }))
mock.module("@/context/settings", () => ({ useSettings: () => ({ general: { workGraph: () => false } }) }))
mock.module("../../src/components/settings-dialog", () => ({ useSettingsDialog: () => () => {} }))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    version: "0.1.0",
    os: "windows",
    platform: "desktop",
    openLink: () => {},
    feedbackDiagnostics: async () => ({ version: host.version }),
    captureFeedbackScreenshot: async () => {
      host.captures++
      return host.capture
    },
    submitFeedback: async (snapshot: Feedback.Snapshot) => {
      payloads.push(snapshot)
      if (host.failure) throw new Error("offline")
      return { submitted: true, receipt: "12345678-1234-4123-8123-123456789abc" }
    },
  }),
}))
const { FeedbackHost } = await import("../../src/components/feedback-host")
const { DesktopRail } = await import("../../src/components/desktop-rail")
const { ExecutionErrorCard } = await import("../../src/components/execution-error-card")
const disposals: (() => void)[] = []
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  payloads.length = 0
  host.version = "0.1.0"
  host.failure = false
  host.captures = 0
})
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name)!
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
function mount(entries = false) {
  const root = document.createElement("main")
  document.body.append(root)
  disposals.push(
    render(
      () => (
        <I18nProvider value={language}>
          {entries && (
            <>
              <DesktopRail />
              <ExecutionErrorCard detail="HTTP 400" mascot={false} />
            </>
          )}
          <FeedbackHost />
        </I18nProvider>
      ),
      root,
    ),
  )
}
function describe(value: string) {
  const input = document.querySelector("textarea")!
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
}
const conversation = () =>
  [...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].find((input) =>
    input.parentElement!.textContent!.includes("附带当前对话"),
  )!

test("766 menu, error and slash open the same single-page Host with required description", async () => {
  mount(true)
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="设置"]')!
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  await settle()
  document
    .querySelector<HTMLElement>('[data-feedback-entry="menu"]')!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  await settle()
  const dialog = document.querySelector('[data-component="feedback-dialog"]')!
  expect(dialog).not.toBeNull()
  expect(button("提交反馈").disabled).toBe(true)
  document.querySelector<HTMLElement>('[data-feedback-entry="error"]')!.click()
  await settle()
  expect(document.querySelector('[data-component="feedback-dialog"]')).toBe(dialog)
  expect(openFeedbackSlash("/bug steps")).toBe(true)
  expect(openFeedbackSlash("/bugs steps")).toBe(false)
  await settle()
  expect(document.querySelectorAll('[data-component="feedback-dialog"]')).toHaveLength(1)
  expect(document.querySelector("textarea")!.value).toBe("steps")
  expect(button("提交反馈").disabled).toBe(false)
})
for (const beta of [false, true]) {
  test(`766 default conversation applies to beta=${beta}; payload is bounded/redacted and success closes`, async () => {
    host.version = beta ? "0.1.0-beta.123" : "0.1.0"
    mount()
    const now = Date.now()
    openFeedback({
      description: 'steps api_key="SECRET_766"',
      sessionID: "ses_current",
      context: {
        events: [{ at: now - 1200000, kind: "bash", state: "error" }],
        errors: [{ at: now - 1200000, status: 400, requestID: "req_766" }],
      },
      readConversation: () => 'CONVERSATION api_key="SECRET_766"',
    })
    await settle()
    expect(conversation().checked).toBe(true)
    button("提交反馈").click()
    await settle()
    expect(payloads).toHaveLength(1)
    const report = JSON.parse(payloads[0].text)
    expect(report.sessionID).toBe("ses_current")
    expect(report.errors[0]).toMatchObject({
      status: 400,
      requestID: "req_766",
      at: new Date(now - 1200000).toISOString(),
    })
    expect(JSON.stringify(payloads[0])).not.toContain("SECRET_766")
    expect(payloads[0].files.some((file) => file.name === "conversation.txt")).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(document.querySelector('[data-component="feedback-dialog"]')).toBeNull()
  })
}
test("766 current-page screenshot is bounded and the exact preview is submitted", async () => {
  mount()
  openFeedback({ description: "capture" })
  await settle()
  host.capture = "data:image/png;base64," + "A".repeat(4000001)
  button("截取当前页面").click()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(document.querySelector("img")).toBeNull()
  expect(host.captures).toBe(1)
  host.capture =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDosAAAAASUVORK5CYII="
  button("截取当前页面").click()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(document.querySelector("img")?.getAttribute("src")).toBe(host.capture)
  button("提交反馈").click()
  await settle()
  expect(payloads[0].image).toBe(host.capture)
})
