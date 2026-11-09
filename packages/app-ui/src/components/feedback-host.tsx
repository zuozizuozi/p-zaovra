import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { For, Show, batch, createMemo, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Dialog } from "@zaovra-ai/ui/dialog"
import { Button } from "@zaovra-ai/ui/button"
import { Feedback } from "@zaovra-ai/schema/feedback"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { FeedbackRequest } from "@/feedback"

const labels = {
  zh: {
    title: "发送反馈",
    description: "问题描述",
    placeholder: "发生了什么？你期望看到什么？",
    local: "内容先留在本机，点击提交反馈后才发送。",
    back: "返回",
    preview: "查看将发送的内容",
    conversation: "附带当前对话",
    conversationHint: "最近20条消息，可能包含代码；发送前会打码。",
    diagnostics: "附带诊断信息",
    diagnosticsHint: "版本、系统、模型及最近30分钟的事件和错误摘要，不含原始日志。",
    capture: "截取当前页面",
    recapture: "重新截图",
    remove: "删除截图",
    screenshot: "当前页面截图",
    imageHint: "请检查截图中的私人内容；图片不会自动打码。",
    noImage: "尚未添加截图。截取后可预览、删除或重新截取。",
    noCapture: "当前环境无法截取页面，仍可提交文字反馈。",
    busy: "正在准备诊断信息，现有内容仍可提交。",
    unavailable: "部分诊断信息暂不可用，仍可提交反馈。",
    failed: "提交没有完成，内容已保留，请重试。",
    captureFailed: "截图没有完成，已有截图和描述已保留，请重试。",
    submit: "提交反馈",
    submitting: "正在提交…",
    submitted: "已提交",
    receipt: "已提交，编号：",
    submitUnavailable: "当前环境暂时无法提交反馈。",
  },
  en: {
    title: "Send feedback",
    description: "Description",
    placeholder: "What happened, and what did you expect?",
    local: "Content stays on this device until you select Submit feedback.",
    back: "Back",
    preview: "Review what will be sent",
    conversation: "Include current conversation",
    conversationHint: "The latest 20 messages, which may contain code; redacted before sending.",
    diagnostics: "Include diagnostics",
    diagnosticsHint: "Version, system, model, and event and error summaries from the last 30 minutes. No raw logs.",
    capture: "Capture current page",
    recapture: "Retake screenshot",
    remove: "Delete screenshot",
    screenshot: "Current page screenshot",
    imageHint: "Check the screenshot for private content. Images are not automatically redacted.",
    noImage: "No screenshot attached. Capture the page to preview, remove, or retake it.",
    noCapture: "Page capture is unavailable here. You can still submit a text report.",
    busy: "Preparing diagnostics. You can submit the information already available.",
    unavailable: "Some diagnostics are unavailable. You can still submit feedback.",
    failed: "Submission failed. Your content is retained; try again.",
    captureFailed: "Capture failed. Your description and existing screenshot are retained; try again.",
    submit: "Submit feedback",
    submitting: "Submitting…",
    submitted: "Submitted",
    receipt: "Submitted. Receipt: ",
    submitUnavailable: "Feedback submission is unavailable here.",
  },
}

export function FeedbackHost() {
  const platform = usePlatform()
  const language = useLanguage()
  const text = () => (language.locale().startsWith("zh") ? labels.zh : labels.en)
  const [state, setState] = createStore({
    open: false,
    generation: 0,
    busy: false,
    pending: false,
    capturing: false,
    description: "",
    notice: "",
    receipt: "",
    image: undefined as string | undefined,
    context: {} as Feedback.Context,
    conversationIncluded: true,
    diagnosticsIncluded: true,
    readConversation: undefined as (() => string) | undefined,
    preview: undefined as Feedback.Snapshot | undefined,
  })
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const close = () => {
    clearTimeout(closeTimer)
    if (state.receipt) setState({ description: "", readConversation: undefined, image: undefined, preview: undefined })
    setState({ open: false, generation: state.generation + 1 })
  }
  const receive = (event: Event) => {
    clearTimeout(closeTimer)
    const request = (event as CustomEvent<FeedbackRequest>).detail ?? {}
    const generation = state.generation + 1
    const context = request.context ?? {}
    batch(() => {
      setState({
        open: true,
        generation,
        busy: true,
        pending: false,
        capturing: false,
        description: request.description ?? state.description,
        notice: "",
        receipt: "",
        image: undefined,
        preview: undefined,
        conversationIncluded: true,
        diagnosticsIncluded: true,
        readConversation: request.readConversation,
      })
      setState(
        "context",
        reconcile({
          ...context,
          sessionID: request.sessionID ?? context.sessionID,
          version: context.version ?? platform.version,
          platform: platform.os ?? "web",
        }),
      )
    })
    void (platform.feedbackDiagnostics?.() ?? Promise.resolve<Feedback.Context>({}))
      .then((native) => {
        if (state.generation !== generation || state.preview) return
        setState(
          "context",
          reconcile({
            ...native,
            ...context,
            sessionID: request.sessionID ?? context.sessionID,
            version: native.version ?? platform.version,
            platform: platform.os ?? "web",
            events: [...(native.events ?? []), ...(context.events ?? [])],
            errors: [...(native.errors ?? []), ...(context.errors ?? [])],
          }),
        )
      })
      .catch(() => {
        if (state.generation === generation) setState("notice", text().unavailable)
      })
      .finally(() => {
        if (state.generation === generation) setState("busy", false)
      })
  }
  window.addEventListener("zaovra:feedback", receive)
  onCleanup(() => {
    clearTimeout(closeTimer)
    window.removeEventListener("zaovra:feedback", receive)
  })
  const snapshot = createMemo(() => {
    if (!state.open) return
    return (
      state.preview ??
      Feedback.snapshot({
        now: Date.now(),
        description: state.description,
        context: state.diagnosticsIncluded
          ? state.context
          : { sessionID: state.conversationIncluded ? state.context.sessionID : undefined },
        include: {
          environment: state.diagnosticsIncluded,
          events: state.diagnosticsIncluded,
          errors: state.diagnosticsIncluded,
        },
        conversation: state.conversationIncluded ? state.readConversation?.() : undefined,
        image: state.image,
        ...(state.diagnosticsIncluded
          ? { modelNames: { model: state.context.model, provider: state.context.provider } }
          : {}),
      })
    )
  })
  const submit = async () => {
    const send = platform.submitFeedback
    if (!send || state.pending || state.capturing || state.receipt || !state.description.trim()) return
    const frozen = snapshot()
    if (!frozen) return
    const generation = state.generation
    setState({ preview: frozen, pending: true, notice: "" })
    await Promise.resolve()
      .then(() => send(frozen))
      .then((result) => {
        if (
          !result.submitted ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.receipt)
        )
          throw new Error("Invalid feedback receipt")
        if (state.generation !== generation) return
        setState({ receipt: result.receipt, notice: text().receipt + result.receipt })
        closeTimer = setTimeout(() => {
          if (state.generation !== generation) return
          close()
          setState({ description: "", readConversation: undefined, image: undefined, preview: undefined })
        }, 700)
      })
      .catch(() => {
        if (state.generation === generation) setState("notice", text().failed)
      })
      .finally(() => {
        if (state.generation === generation) setState("pending", false)
      })
  }
  const capture = async () => {
    const take = platform.captureFeedbackScreenshot
    if (!take || state.pending || state.capturing) return
    const generation = state.generation
    setState({ capturing: true, preview: undefined, notice: "" })
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    if (!state.open || state.generation !== generation) return
    await Promise.resolve()
      .then(take)
      .then((image) => {
        if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 4_000_000)
          throw new Error("Invalid screenshot")
        const bytes = Uint8Array.from(atob(image.split(",")[1]), (char) => char.charCodeAt(0))
        const header = new DataView(bytes.buffer)
        if (
          bytes.length > 3_000_000 ||
          bytes.length < 24 ||
          header.getUint32(0) !== 0x89504e47 ||
          header.getUint32(4) !== 0x0d0a1a0a ||
          !header.getUint32(16) ||
          !header.getUint32(20) ||
          header.getUint32(16) * header.getUint32(20) > 8_000_000
        )
          throw new Error("Invalid screenshot")
        if (state.open && state.generation === generation) setState("image", image)
      })
      .catch(() => {
        if (state.generation === generation) setState("notice", text().captureFailed)
      })
      .finally(() => {
        if (state.generation === generation) setState("capturing", false)
      })
  }
  const disabled = () => state.pending || state.capturing || !!state.receipt
  return (
    <Kobalte
      open={state.open}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <Show when={state.open}>
        <Kobalte.Portal>
          <Kobalte.Overlay
            style={{ visibility: state.capturing ? "hidden" : undefined }}
            class="fixed inset-0 z-[10000] bg-black/40"
          />
          <div
            style={{ visibility: state.capturing ? "hidden" : undefined }}
            class="fixed inset-0 z-[10001] flex items-center justify-center p-3 pointer-events-none"
          >
            <Dialog title={text().title} size="large" class="pointer-events-auto h-full max-h-[90dvh] overflow-hidden">
              <div
                data-component="feedback-dialog"
                class="flex h-full min-h-0 min-w-0 flex-col gap-4 px-4 pb-4 text-13-regular"
              >
                <p class="text-text-weak">{text().local}</p>
                <div data-component="feedback-scroll" class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
                  <label class="flex flex-col gap-2">
                    {text().description}
                    <textarea
                      autofocus
                      required
                      rows={4}
                      maxLength={2000}
                      placeholder={text().placeholder}
                      disabled={disabled()}
                      value={state.description}
                      onInput={(event) => setState({ description: event.currentTarget.value, preview: undefined })}
                      class="rounded-md border border-border-base bg-background-base p-2 resize-y"
                    />
                  </label>
                  <section aria-label={text().screenshot} class="flex min-w-0 flex-col gap-2">
                    <Show when={state.image} fallback={<p class="text-text-weak">{text().noImage}</p>}>
                      <img
                        src={state.image}
                        alt={text().screenshot}
                        class="max-h-64 w-full rounded-md border border-border-base object-contain"
                      />
                      <p class="text-text-weak">{text().imageHint}</p>
                    </Show>
                    <div class="flex flex-wrap gap-2">
                      <Show
                        when={platform.captureFeedbackScreenshot}
                        fallback={<p class="text-text-weak">{text().noCapture}</p>}
                      >
                        <Button variant="secondary" disabled={disabled()} onClick={() => void capture()}>
                          {state.image ? text().recapture : text().capture}
                        </Button>
                      </Show>
                      <Show when={state.image}>
                        <Button
                          variant="ghost"
                          disabled={disabled()}
                          onClick={() => setState({ image: undefined, preview: undefined })}
                        >
                          {text().remove}
                        </Button>
                      </Show>
                    </div>
                  </section>
                  <label class="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={state.conversationIncluded}
                      disabled={disabled() || !state.readConversation}
                      onChange={(event) =>
                        setState({ conversationIncluded: event.currentTarget.checked, preview: undefined })
                      }
                    />
                    <span>
                      {text().conversation}
                      <span class="block text-text-weak">{text().conversationHint}</span>
                    </span>
                  </label>
                  <label class="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={state.diagnosticsIncluded}
                      disabled={disabled()}
                      onChange={(event) =>
                        setState({ diagnosticsIncluded: event.currentTarget.checked, preview: undefined })
                      }
                    />
                    <span>
                      {text().diagnostics}
                      <span class="block text-text-weak">{text().diagnosticsHint}</span>
                    </span>
                  </label>
                  <details data-component="feedback-preview">
                    <summary class="cursor-pointer text-text-weak">{text().preview}</summary>
                    <For each={snapshot()?.files}>
                      {(file) => (
                        <div class="mt-3">
                          <h3 class="font-medium">{file.name}</h3>
                          <pre class="max-h-64 select-text overflow-auto whitespace-pre-wrap break-all">
                            {file.text}
                          </pre>
                        </div>
                      )}
                    </For>
                  </details>
                  <Show when={state.busy}>
                    <p role="status" class="text-text-weak">
                      {text().busy}
                    </p>
                  </Show>
                </div>
                <div data-component="feedback-actions" class="flex shrink-0 flex-wrap gap-2">
                  <Button
                    disabled={disabled() || !state.description.trim() || !platform.submitFeedback}
                    onClick={() => void submit()}
                  >
                    {state.receipt ? text().submitted : state.pending ? text().submitting : text().submit}
                  </Button>
                  <Button variant="ghost" disabled={state.pending || state.capturing} onClick={close}>
                    {text().back}
                  </Button>
                </div>
                <Show when={!platform.submitFeedback}>
                  <p role="status">{text().submitUnavailable}</p>
                </Show>
                <Show when={state.notice}>
                  <p role="status">{state.notice}</p>
                </Show>
              </div>
            </Dialog>
          </div>
        </Kobalte.Portal>
      </Show>
    </Kobalte>
  )
}
