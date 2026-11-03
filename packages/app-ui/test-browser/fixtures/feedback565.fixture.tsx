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
    input.parentElement!.textContent!.includes("对话正文"),
  )!

test("actual settings menu, error card and slash handler open the same single Host; description is required", async () => {
  mount(true)
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="设置"]')!
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  await settle()
  document
    .querySelector<HTMLElement>('[data-feedback-entry="menu"]')!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  await settle()
  const dialog = document.querySelector('[data-component="feedback-dialog"]')!
  expect(!!dialog, "menu opens Host").toBe(true)
  expect(document.body.textContent).toContain("发送反馈")
  expect(button("继续反馈").disabled, "empty description blocks preview").toBe(true)
  document.querySelector<HTMLElement>('[data-feedback-entry="error"]')!.click()
  await settle()
  expect(document.querySelector('[data-component="feedback-dialog"]')).toBe(dialog)
  expect(openFeedbackSlash("/bug steps")).toBe(true)
  expect(openFeedbackSlash("/bugs steps")).toBe(false)
  await settle()
  expect(document.querySelectorAll('[data-component="feedback-dialog"]')).toHaveLength(1)
  expect(document.querySelector("textarea")!.value).toBe("steps")
  expect(button("继续反馈").disabled).toBe(false)
})

for (const beta of [false, true]) {
  test(`native channel controls conversation default: beta=${beta}; submitted payload is bounded and redacted`, async () => {
    host.version = beta ? "0.1.0-beta.123" : "0.1.0"
    mount()
    let reads = 0
    const now = Date.now()
    openFeedback({
      description: 'steps api_key="SECRET_565"',
      sessionID: "ses_current",
      context: {
        events: [{ at: now - 1_200_000, kind: "bash", state: "error" }],
        errors: [
          { at: now - 1_200_000, status: 400, diagnosticMessage: 'HTTP 400 token="SECRET_565"', requestID: "req_565" },
        ],
      },
      readConversation: () => {
        reads++
        return 'CONVERSATION api_key="SECRET_565"'
      },
    })
    await settle()
    expect(conversation().checked).toBe(beta)
    expect(reads).toBe(beta ? 1 : 0)
    button("继续反馈").click()
    await settle()
    button("提交反馈").click()
    button("提交反馈").click()
    await settle()
    expect(payloads).toHaveLength(1)
    const report = JSON.parse(payloads[0].text)
    expect(report.sessionID).toBe("ses_current")
    expect(report.errors[0]).toMatchObject({
      status: 400,
      requestID: "req_565",
      at: new Date(now - 1_200_000).toISOString(),
    })
    expect(report.events[0].at).toBe(new Date(now - 1_200_000).toISOString())
    expect(JSON.stringify(payloads[0])).not.toContain("SECRET_565")
    expect(payloads[0].files.some((file) => file.name === "conversation.txt")).toBe(beta)
    expect(document.body.textContent).toContain("已提交")
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(!!document.querySelector('[data-component="feedback-dialog"]')).toBe(false)
  })
}

test("changing or removing session replaces scene data; failed submission retains editable description", async () => {
  mount()
  const calls: (string | undefined)[] = []
  openFeedback({
    description: "retain",
    sessionID: "ses_first",
    context: { sessionID: "ses_first" },
    sessions: [
      { id: "ses_first", title: "First" },
      { id: "ses_second", title: "Second" },
    ],
    selectSession: async (id) => {
      calls.push(id)
      return { context: id ? { sessionID: id, errors: [{ at: Date.now(), status: 429 }] } : {} }
    },
  })
  await settle()
  const select = document.querySelector("select")!
  select.value = "ses_second"
  select.dispatchEvent(new Event("change", { bubbles: true }))
  await settle()
  button("继续反馈").click()
  await settle()
  host.failure = true
  button("提交反馈").click()
  await settle()
  expect(JSON.parse(payloads[0].text).sessionID).toBe("ses_second")
  expect(document.body.textContent).toContain("未自动发送")
  button("返回修改").click()
  expect(document.querySelector("textarea")!.value).toBe("retain")
  const unrelated = document.querySelector("select")!
  unrelated.value = ""
  unrelated.dispatchEvent(new Event("change", { bubbles: true }))
  await settle()
  button("继续反馈").click()
  await settle()
  button("提交反馈").click()
  await settle()
  expect(JSON.parse(payloads[1].text).sessionID).toBeUndefined()
  expect(JSON.parse(payloads[1].text).errors).toEqual([])
  expect(calls).toEqual(["ses_second", undefined])
})

test("paste and drop reject excessive screenshots; capture is explicit and size checked", async () => {
  mount()
  openFeedback({ description: "image limits" })
  await settle()
  const dialog = document.querySelector('[data-component="feedback-dialog"]')!
  for (const type of ["paste", "drop"]) {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", {
      value: { files: [new File([new Uint8Array(3_000_001)], "large.png", { type: "image/png" })] },
    })
    dialog.dispatchEvent(event)
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(!!dialog.querySelector("img")).toBe(false)
    expect(document.body.textContent).toContain("未自动发送")
  }
  expect(host.captures).toBe(0)
  host.capture = "data:image/png;base64," + "A".repeat(4_000_001)
  button("截取当前窗口").click()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(host.captures).toBe(1)
  expect(!!dialog.querySelector("img")).toBe(false)
})

test("explicit current-window capture reaches the exact reviewed submission payload", async () => {
  host.capture =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDosAAAAASUVORK5CYII="
  mount()
  openFeedback({ description: "capture" })
  await settle()
  expect(host.captures).toBe(0)
  button("截取当前窗口").click()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(host.captures).toBe(1)
  expect(document.querySelector('[data-component="feedback-dialog"] img')?.getAttribute("src")).toBe(host.capture)
  button("继续反馈").click()
  await settle()
  button("提交反馈").click()
  await settle()
  expect(payloads[0].image).toBe(host.capture)
})
