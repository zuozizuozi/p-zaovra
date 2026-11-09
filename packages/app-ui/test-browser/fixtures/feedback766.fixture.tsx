import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { dict } from "../../../ui/src/i18n/zh"
import type { Feedback } from "@zaovra-ai/schema/feedback"
import { openFeedback } from "../../src/feedback"
import { redactionSamples } from "../../../schema/test/fixtures/feedback-redaction"

const language = { locale: () => host.locale, t: (key: string) => dict[key as keyof typeof dict] ?? key }
const host = {
  locale: "zh",
  failure: false,
  captures: 0,
  image:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=",
  diagnostics: undefined as Promise<Feedback.Context> | undefined,
  upload: undefined as Promise<void> | undefined,
  take: undefined as Promise<string> | undefined,
}
const sent: Feedback.Snapshot[] = []
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    version: "0.1.0",
    platform: "desktop",
    os: "windows",
    feedbackDiagnostics: async () =>
      host.diagnostics ?? { events: [{ at: Date.now(), kind: "main", state: "error", args: "PRIVATE_RAW_BODY" }] },
    captureFeedbackScreenshot: async () => {
      host.captures++
      return host.take ?? host.image
    },
    submitFeedback: async (snapshot: Feedback.Snapshot) => {
      sent.push(snapshot)
      if (host.upload) await host.upload
      if (host.failure) throw new Error("offline")
      return { submitted: true as const, receipt: JSON.parse(snapshot.text).reportID as string }
    },
  }),
}))
const { FeedbackHost } = await import("../../src/components/feedback-host")
const disposals: Array<() => void> = []
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  sent.length = 0
  host.locale = "zh"
  host.failure = false
  host.captures = 0
  host.diagnostics = undefined
  host.upload = undefined
  host.take = undefined
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 35))
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text)!
function mount() {
  const root = document.createElement("main")
  document.body.append(root)
  disposals.push(
    render(
      () => (
        <I18nProvider value={language}>
          <FeedbackHost />
        </I18nProvider>
      ),
      root,
    ),
  )
}
for (const locale of ["zh", "en"]) {
  test(`766 ${locale} single page has two footer actions, default attachments and collapsed raw content`, async () => {
    host.locale = locale
    mount()
    openFeedback({
      description: "A problem",
      readConversation: () => "user conversation",
      context: { sessionID: "ses_fixture766" },
    })
    await settle()
    expect(
      [...document.querySelectorAll('[data-component="feedback-actions"] button')].map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(locale === "zh" ? ["提交反馈", "返回"] : ["Submit feedback", "Back"])
    expect(
      [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((node) => node.checked),
    ).toEqual([true, true])
    expect(document.querySelector<HTMLDetailsElement>('[data-component="feedback-preview"]')!.open).toBe(false)
    expect(document.querySelector('select,input[type="file"]')).toBeNull()
    expect(host.captures).toBe(0)
    expect(sent).toHaveLength(0)
  })
}
test("766 deselecting both attachments removes conversation, diagnostic fields, model names and session identity", async () => {
  mount()
  openFeedback({
    description: "Problem",
    readConversation: () => "PRIVATE_CONVERSATION",
    context: { sessionID: "ses_fixture766", provider: "private provider", model: "private model" },
  })
  await settle()
  document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((node) => node.click())
  button("提交反馈").click()
  await settle()
  expect(sent[0].files.map((file) => file.name)).toEqual(["report.json"])
  expect(sent[0].text).not.toContain("environment")
  expect(sent[0].text).not.toContain("events")
  expect(sent[0].text).not.toContain("sessionID")
  expect(JSON.stringify(sent[0])).not.toContain("PRIVATE_CONVERSATION")
})
test("766 capture can be previewed, failed recapture retains it, deletion excludes it from submission", async () => {
  mount()
  openFeedback({ description: "Screenshot issue" })
  await settle()
  button("截取当前页面").click()
  await settle()
  await settle()
  expect(document.querySelector<HTMLImageElement>("img")!.src).toBe(host.image)
  expect(host.captures).toBe(1)
  host.take = Promise.resolve("invalid image")
  button("重新截图").click()
  await settle()
  await settle()
  expect(document.querySelector<HTMLImageElement>("img")!.src).toBe(host.image)
  expect(document.body.textContent).toContain("截图没有完成")
  button("删除截图").click()
  await settle()
  expect(document.querySelector("img")).toBeNull()
  button("提交反馈").click()
  await settle()
  expect(sent[0].image).toBeUndefined()
})
test("766 pending diagnostics do not block submission or mutate its frozen payload", async () => {
  let finishDiagnostics: (context: Feedback.Context) => void = () => {}
  let finishUpload: () => void = () => {}
  host.diagnostics = new Promise((resolve) => {
    finishDiagnostics = resolve
  })
  host.upload = new Promise((resolve) => {
    finishUpload = resolve
  })
  mount()
  openFeedback({ description: "Early report" })
  await settle()
  button("提交反馈").click()
  button("正在提交…").click()
  await settle()
  expect(sent).toHaveLength(1)
  const frozen = sent[0].text
  finishDiagnostics({ errors: [{ at: Date.now(), status: 500, category: "network" }] })
  await settle()
  expect(sent[0].text).toBe(frozen)
  expect(sent[0].text).not.toContain('"status": 500')
  finishUpload()
  await settle()
  expect(document.body.textContent).toContain("已提交，编号：")
})
test("766 a failed send stays editable and a late screenshot cannot enter a reopened report", async () => {
  host.failure = true
  mount()
  openFeedback({ description: "Keep my description" })
  await settle()
  button("提交反馈").click()
  await settle()
  expect(document.querySelector("textarea")!.value).toBe("Keep my description")
  expect(document.querySelector("textarea")!.disabled).toBe(false)
  expect(document.body.textContent).toContain("内容已保留")
  let finishCapture: (value: string) => void = () => {}
  host.take = new Promise((resolve) => {
    finishCapture = resolve
  })
  button("截取当前页面").click()
  await settle()
  openFeedback({ description: "Different report" })
  await settle()
  finishCapture(host.image)
  await settle()
  expect(document.querySelector("img")).toBeNull()
  expect(document.querySelector("textarea")!.value).toBe("Different report")
})
for (const sample of redactionSamples) {
  test(`766 submitted description, conversation and model names redact ${sample.name}`, async () => {
    mount()
    openFeedback({
      description: sample.text,
      readConversation: () => sample.text,
      context: { model: sample.text, provider: sample.text },
    })
    await settle()
    button("提交反馈").click()
    await settle()
    const payload = JSON.stringify(sent[0])
    expect(payload).not.toContain(sample.marker)
    for (const value of sample.preserve) expect(payload).toContain(value)
    expect(payload).not.toContain("PRIVATE_RAW_BODY")
  })
}

test("766 opening an unrelated report clears the prior session scene and keeps explicit attachment choices", async () => {
  mount()
  openFeedback({
    description: "Old report",
    context: { sessionID: "ses_previous", model: "old model", errors: [{ at: Date.now(), status: 429 }] },
  })
  await settle()
  openFeedback({ description: "Unrelated report" })
  await settle()
  button("提交反馈").click()
  await settle()
  const report = JSON.parse(sent[0].text)
  expect(report.sessionID).toBeUndefined()
  expect(report.errors).toEqual([])
  expect(JSON.stringify(sent[0])).not.toContain("old model")
})
