import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { render } from "solid-js/web"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { dict } from "../../../ui/src/i18n/zh"
import type { Feedback } from "@zaovra-ai/schema/feedback"
import { openFeedback } from "../../src/feedback"
import { redactionInputs, redactionSamples } from "../../../schema/test/fixtures/feedback-redaction"

const saves: Feedback.Snapshot[] = []
const links: string[] = []
const failure = { save: false, diagnostics: undefined as Promise<Feedback.Context> | undefined }
const language = { locale: () => "zh", t: (key: string) => dict[key as keyof typeof dict] ?? key }
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    version: "0.1.0",
    platform: "desktop",
    os: "windows",
    openLink: (url: string) => links.push(url),
    feedbackDiagnostics: async () =>
      failure.diagnostics ?? {
        events: [{ at: Date.now(), kind: "main", state: "error", args: "SECRET_BODY" }],
      },
    saveFeedback: async (snapshot: Feedback.Snapshot) => {
      saves.push(snapshot)
      if (failure.save) throw new Error("offline")
      return false
    },
  }),
}))
const { FeedbackHost } = await import("../../src/components/feedback-host")
const disposals: (() => void)[] = []
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  saves.length = 0
  links.length = 0
  failure.save = false
  failure.diagnostics = undefined
})
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name)!
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 25))
}
function mount() {
  const host = document.createElement("main")
  document.body.append(host)
  disposals.push(
    render(
      () => (
        <I18nProvider value={language}>
          <FeedbackHost />
        </I18nProvider>
      ),
      host,
    ),
  )
}

for (const error of ["401", "429", "proxy failed", "unclassified"]) {
  test(`standalone error fallback: ${error} permits export and retains description after cancel/failure`, async () => {
    mount()
    openFeedback({ error: `${error} SECRET_BODY`, description: "expected action" })
    await settle()
    expect(button("继续反馈")).toBeTruthy()
    button("继续反馈").click()
    await settle()
    const preview = document.querySelector("[data-component=feedback-dialog]")!.textContent!
    expect(preview).not.toContain("SECRET_BODY")
    button("保存诊断包 ZIP").click()
    await settle()
    expect(document.body.textContent).toContain("已取消保存")
    const snapshot = saves[0]
    expect(snapshot.text).toContain("expected action")
    failure.save = true
    button("保存诊断包 ZIP").click()
    await settle()
    expect(document.body.textContent).toContain("未自动发送")
    expect(saves[1]).toBe(snapshot)
    expect(links).toHaveLength(0)
    button("返回修改").click()
    expect(document.querySelector("textarea")!.value).toBe("expected action")
    expect(button("继续反馈")).toBeTruthy()
  })
}

test("conversation is not read before opt-in, deselection removes it, and later context changes cannot change the preview", async () => {
  mount()
  let reads = 0
  const context = { events: [{ at: Date.now(), kind: "read", state: "error" }] }
  openFeedback({
    description: "steps",
    context,
    readConversation: () => {
      reads++
      return "OPTED_IN_BODY"
    },
  })
  await settle()
  expect(reads).toBe(0)
  const checkbox = [...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].find((input) =>
    input.parentElement!.textContent!.includes("对话正文"),
  )!
  checkbox.click()
  expect(reads).toBe(1)
  checkbox.click()
  button("继续反馈").click()
  await settle()
  context.events[0].kind = "LATER_SECRET"
  button("保存诊断包 ZIP").click()
  await settle()
  expect(saves[0].files).toHaveLength(1)
  expect(saves[0].text).not.toContain("LATER_SECRET")
  expect(saves[0].text).not.toContain("OPTED_IN_BODY")
  const copied: string[] = []
  const copy = spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
    copied.push(text)
  })
  button("复制报告").click()
  await settle()
  button("打开邮件草稿").click()
  expect(decodeURIComponent(links[0].split("&body=")[1])).toBe(copied[0])
  expect(copied[0]).toContain(saves[0].text)
  copy.mockRestore()
})

test("a pending diagnostics request cannot block feedback, and late logs cannot change an approved snapshot", async () => {
  const gate = Promise.withResolvers<Feedback.Context>()
  failure.diagnostics = gate.promise
  mount()
  openFeedback({ description: "retain me" })
  await settle()
  expect(button("继续反馈").disabled).toBe(false)
  button("继续反馈").click()
  await settle()
  gate.resolve({ events: [{ at: Date.now(), kind: "LATER_SECRET", state: "error" }] })
  await settle()
  button("保存诊断包 ZIP").click()
  await settle()
  expect(saves[0].text).not.toContain("LATER_SECRET")
  expect(JSON.parse(saves[0].text).environment.version).toBe("0.1.0")
})

test("returning from a settings suggestion keeps the description and permits feedback without probes", async () => {
  mount()
  let configured = 0
  openFeedback({
    error: "401",
    description: "original steps",
    configure: () => {
      configured++
    },
  })
  await settle()
  button("检查模型服务设置（反馈描述保留）").click()
  expect(configured).toBe(1)
  openFeedback()
  await settle()
  expect(document.querySelector("textarea")!.value).toBe("original steps")
  expect(button("继续反馈")).toBeTruthy()
  expect(links).toHaveLength(0)
})

for (const sample of redactionSamples) {
  for (const input of redactionInputs) {
    test(sample.name + " through " + input + ": Host preview/copy/save/mail share a clean snapshot", async () => {
      mount()
      openFeedback({
        description: input === "description" ? sample.text : "APPROVED_NOTE_409",
        ...(input === "details" ? { error: sample.text } : {}),
        ...(input === "conversation" ? { readConversation: () => sample.text } : {}),
      })
      await settle()
      if (input === "details" || input === "conversation") {
        const label = input === "details" ? "原始详情" : "对话正文"
        ;[...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
          .find((item) => item.parentElement!.textContent!.includes(label))!
          .click()
      }
      if (input === "code") {
        const file = document.querySelector<HTMLInputElement>('input[accept^="text/"]')!
        Object.defineProperty(file, "files", {
          configurable: true,
          value: [new File([sample.text], "synthetic.json", { type: "application/json" })],
        })
        file.dispatchEvent(new Event("change", { bubbles: true }))
        await settle()
      }
      button("继续反馈").click()
      await settle()
      const preview = document.querySelector("[data-component=feedback-dialog]")!.textContent!
      const copies: string[] = []
      const copy = spyOn(navigator.clipboard, "writeText").mockImplementation(async (value) => {
        copies.push(value)
      })
      try {
        button("复制报告").click()
        await settle()
        button("保存诊断包 ZIP").click()
        await settle()
        button("打开邮件草稿").click()
      } finally {
        copy.mockRestore()
      }
      const snapshot = saves[0]
      const mail = decodeURIComponent(links[0].split("&body=")[1])
      // Capture the actual Host save payload for separate native archive validation.
      const directory = Bun.env.ZAOVRA_FEEDBACK_EVIDENCE_DIR
      if (directory) {
        await Bun.write(
          directory + "/" + sample.name + "-" + input + ".json",
          JSON.stringify({ marker: sample.marker, preview, copied: copies[0], mail, snapshot }, null, 2),
        )
      }
      expect([preview, copies[0], mail, ...snapshot.files.map((file) => file.text)].join("\n")).not.toContain(
        sample.marker,
      )
      expect(copies[0]).toBe(mail)
      expect(copies[0]).toContain(snapshot.text)
      expect(copies[0]).toContain("APPROVED_NOTE_409")
      button("返回修改").click()
      if (input === "details" || input === "conversation") {
        const label = input === "details" ? "原始详情" : "对话正文"
        ;[...document.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
          .find((item) => item.parentElement!.textContent!.includes(label))!
          .click()
      }
      if (input === "code") button("移除 主动选择代码或文本文件").click()
      button("继续反馈").click()
      await settle()
      button("保存诊断包 ZIP").click()
      await settle()
      expect(saves[1].files.map((file) => file.name)).toEqual(["report.json"])
      expect(saves[1].image).toBeUndefined()
    })
  }
}
