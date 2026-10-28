import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { For, Show, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog } from "@zaovra-ai/ui/dialog"
import { Button } from "@zaovra-ai/ui/button"
import { Feedback } from "@zaovra-ai/schema/feedback"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { FeedbackRequest } from "@/feedback"

const labels = {
  zh: {
    title: "反馈问题",
    description: "发生了什么？你期望看到什么？",
    local: "先在本机准备，不会自动上传。",
    continue: "继续反馈",
    back: "返回修改",
    preview: "实际导出内容预览",
    environment: "版本、系统及模型类别",
    events: "最近5分钟事件摘要（最多50条）",
    errors: "最近错误摘要（最多20条，不含原始日志）",
    details: "附带此错误的原始详情（打码后）",
    conversation: "附带最近对话正文（可能包含代码）",
    code: "主动选择代码或文本文件",
    screenshot: "主动选择 PNG 截图",
    remove: "移除",
    image: "截图像素预览：请先遮挡秘密，再选择图片。不会自动识别图片中的秘密。",
    review: "请逐项检查。自动打码不能识别所有私人内容；原文、代码和截图默认不带。",
    copy: "复制报告",
    save: "保存诊断包 ZIP",
    mail: "打开邮件草稿",
    copied: "已复制，尚未发送。",
    saved: "已保存，尚未发送。",
    cancelled: "已取消保存，描述仍保留。",
    failed: "操作没有完成，未自动发送；请重试或复制报告。",
    emailHint: "邮件草稿只放下方同一份文本；截图请从已保存的诊断包手动附加。",
    largeMail: "文本较长，请复制或保存后手动附加。",
    unknown: "暂时无法判断原因。可以直接继续反馈。",
    auth: "可能涉及认证或服务响应。可核对模型服务设置，也可以继续反馈。",
    credit: "服务可能返回了额度相关响应。可查看服务商用量，也可以继续反馈。",
    rate: "可能遇到限流或暂时不可用。可以稍后再试，也可以继续反馈。",
    network: "可能涉及连接、代理或服务端网络。请核对连接状态；这不代表配置有误，可以继续反馈。",
    model: "可能涉及模型或接口可用性。可核对服务商支持的模型，也可以继续反馈。",
    unavailable: "部分现场暂不可用，仍可继续反馈。",
    empty: "当前没有可选对话。",
    busy: "正在准备本地现场…",
    configure: "检查模型服务设置（反馈描述保留）",
    modelNames: "附带模型与服务商完整名称（可能含自定义文字，打码后预览）",
  },
  en: {
    title: "Report a problem",
    description: "What happened, and what did you expect?",
    local: "Prepared locally. Nothing is uploaded automatically.",
    continue: "Continue feedback",
    back: "Edit report",
    preview: "Exact export preview",
    environment: "Version, system and model family",
    events: "Events from the last 5 minutes (up to 50)",
    errors: "Recent error summaries (up to 20; no raw logs)",
    details: "Include raw details of this error after redaction",
    conversation: "Include recent conversation (may contain code)",
    code: "Choose a code or text file",
    screenshot: "Choose a PNG screenshot",
    remove: "Remove",
    image: "Screenshot pixel preview: mask secrets before selecting. Image secrets are not automatically detected.",
    review:
      "Review each item. Redaction cannot recognize every private phrase. Conversation, code and screenshots are excluded by default.",
    copy: "Copy report",
    save: "Save diagnostic ZIP",
    mail: "Open email draft",
    copied: "Copied, not sent.",
    saved: "Saved, not sent.",
    cancelled: "Save cancelled. Your description is retained.",
    failed: "The action failed. Nothing was sent automatically; retry or copy the report.",
    emailHint: "The email draft uses the same text below. Attach the screenshot manually from the saved ZIP.",
    largeMail: "This report is long. Copy it or save and attach it manually.",
    unknown: "The cause is unclear. You can continue feedback directly.",
    auth: "Authentication or the service response may be involved. Check model service settings, or continue feedback.",
    credit: "The service may have returned a credit response. Check provider usage, or continue feedback.",
    rate: "Rate limits or temporary availability may be involved. Try later, or continue feedback.",
    network:
      "Connection, proxy or service networking may be involved. This does not establish a configuration fault; you can continue feedback.",
    model: "Model or endpoint availability may be involved. Check supported models, or continue feedback.",
    unavailable: "Some diagnostics are unavailable. You can still continue feedback.",
    empty: "No conversation is available here.",
    busy: "Preparing local diagnostics…",
    configure: "Check model service settings (description retained)",
    modelNames: "Include full model and provider names (may contain custom text; review after redaction)",
  },
}

export function FeedbackHost() {
  const platform = usePlatform()
  const language = useLanguage()
  const text = () => (language.locale().startsWith("zh") ? labels.zh : labels.en)
  const [state, setState] = createStore({
    open: false,
    busy: false,
    pending: false,
    description: "",
    error: "",
    notice: "",
    preview: undefined as Feedback.Snapshot | undefined,
    context: {} as Feedback.Context,
    include: { environment: true, events: true, errors: true },
    details: false,
    modelNames: false,
    conversation: undefined as string | undefined,
    code: undefined as string | undefined,
    image: undefined as string | undefined,
    readConversation: undefined as (() => string) | undefined,
    generation: 0,
    configure: undefined as (() => void) | undefined,
  })
  const advice = createMemo(() => Feedback.suggestion(state.error))
  const receive = (event: Event) => {
    const request = (event as CustomEvent<FeedbackRequest>).detail ?? {}
    const generation = state.generation + 1
    setState({
      open: true,
      busy: true,
      pending: false,
      preview: undefined,
      error: request.error ?? "",
      notice: "",
      description: request.description ?? state.description,
      generation,
      context: {
        version: platform.version,
        platform: platform.os ?? "web",
        provider: undefined,
        model: undefined,
        events: [],
        errors: [],
        ...request.context,
      },
      include: { environment: true, events: true, errors: true },
      details: false,
      modelNames: false,
      conversation: undefined,
      code: undefined,
      image: undefined,
      readConversation: request.readConversation,
      configure: request.configure,
    })
    void (platform.feedbackDiagnostics?.() ?? Promise.resolve<Feedback.Context>({}))
      .then((context) => {
        if (state.generation !== generation) return
        setState("context", {
          provider: undefined,
          model: undefined,
          ...context,
          ...request.context,
          version: platform.version ?? context.version,
          platform: platform.os ?? "web",
          events: [...(context.events ?? []), ...(request.context?.events ?? [])],
          errors: [...(context.errors ?? []), ...(request.context?.errors ?? [])],
        })
      })
      .catch(() => {
        if (state.generation === generation) setState("notice", text().unavailable)
      })
      .finally(() => {
        if (state.generation === generation) setState("busy", false)
      })
  }
  window.addEventListener("zaovra:feedback", receive)
  onCleanup(() => window.removeEventListener("zaovra:feedback", receive))
  const freeze = () =>
    setState(
      "preview",
      Feedback.snapshot({
        now: Date.now(),
        description: state.description,
        context: state.context,
        include: state.include,
        ...(state.details ? { details: state.error } : {}),
        conversation: state.conversation,
        code: state.code,
        image: state.image,
        ...(state.modelNames ? { modelNames: { model: state.context.model, provider: state.context.provider } } : {}),
      }),
    )
  const perform = async (action: () => Promise<string>) => {
    if (state.pending) return
    const generation = state.generation
    setState({ notice: "", pending: true })
    await action()
      .then((notice) => {
        if (state.generation === generation) setState("notice", notice)
      })
      .catch(() => {
        if (state.generation === generation) setState("notice", text().failed)
      })
      .finally(() => {
        if (state.generation === generation) setState("pending", false)
      })
  }
  const chooseImage = async (file: File) => {
    const generation = state.generation
    if (file.type !== "image/png" || file.size > 3_000_000) throw new Error("Invalid image")
    const header = new DataView(await file.slice(0, 24).arrayBuffer())
    if (
      header.byteLength < 24 ||
      header.getUint32(0) !== 0x89504e47 ||
      header.getUint32(4) !== 0x0d0a1a0a ||
      header.getUint32(16) * header.getUint32(20) > 8_000_000
    )
      throw new Error("Image too large or invalid")
    const bitmap = await createImageBitmap(file)
    if (bitmap.width * bitmap.height > 8_000_000) {
      bitmap.close()
      throw new Error("Image too large")
    }
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0)
    bitmap.close()
    const image = canvas.toDataURL("image/png")
    if (image.length > 4_000_000) throw new Error("Image too large")
    if (state.open && state.generation === generation && !state.preview) setState("image", image)
    return ""
  }
  return (
    <Kobalte open={state.open} onOpenChange={(open) => setState("open", open)}>
      <Kobalte.Portal>
        <Kobalte.Overlay class="fixed inset-0 z-[10000] bg-black/40" />
        <div class="fixed inset-0 z-[10001] flex items-center justify-center p-3 pointer-events-none">
          <Dialog title={text().title} size="large" class="pointer-events-auto max-h-[90dvh] overflow-y-auto">
            <div
              data-component="feedback-dialog"
              class="flex flex-col gap-4 px-4 pb-4 text-13-regular min-w-0 min-h-0 overflow-y-auto max-h-[70dvh]"
            >
              <p>{text().local}</p>
              <Show
                when={!state.preview}
                fallback={
                  <>
                    <h3>{text().preview}</h3>
                    <For each={state.preview?.files}>
                      {(file) => (
                        <details open>
                          <summary>{file.name}</summary>
                          <pre class="whitespace-pre-wrap break-all select-text max-h-64 overflow-y-auto">
                            {file.text}
                          </pre>
                        </details>
                      )}
                    </For>
                    <Show when={state.preview?.image}>
                      {(image) => (
                        <>
                          <p>{text().image}</p>
                          <img src={image()} alt={text().screenshot} class="max-h-64 object-contain" />
                        </>
                      )}
                    </Show>
                    <p>{text().emailHint}</p>
                    <div class="flex flex-wrap gap-2">
                      <Button disabled={state.pending} onClick={() => setState("preview", undefined)}>
                        {text().back}
                      </Button>
                      <Button
                        disabled={state.pending}
                        onClick={() =>
                          void perform(async () => {
                            await navigator.clipboard.writeText(Feedback.copy(state.preview!))
                            return text().copied
                          })
                        }
                      >
                        {text().copy}
                      </Button>
                      <Show when={platform.saveFeedback}>
                        <Button
                          disabled={state.pending}
                          onClick={() =>
                            void perform(async () =>
                              (await platform.saveFeedback!(state.preview!)) ? text().saved : text().cancelled,
                            )
                          }
                        >
                          {text().save}
                        </Button>
                      </Show>
                      <Button
                        disabled={state.pending || Feedback.copy(state.preview!).length > 8000}
                        title={text().largeMail}
                        onClick={() =>
                          platform.openLink(
                            `mailto:support@zaovra.com?subject=Zaovra%20feedback&body=${encodeURIComponent(Feedback.copy(state.preview!))}`,
                          )
                        }
                      >
                        {text().mail}
                      </Button>
                    </div>
                  </>
                }
              >
                <label class="flex flex-col gap-2">
                  {text().description}
                  <textarea
                    autofocus
                    rows={4}
                    maxLength={2000}
                    value={state.description}
                    onInput={(event) => setState("description", event.currentTarget.value)}
                    class="rounded-md border border-border-base bg-background-base p-2 resize-y"
                  />
                </label>
                <p role="status">{text()[advice()]}</p>
                <Show when={state.configure}>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setState("open", false)
                      state.configure?.()
                    }}
                  >
                    {text().configure}
                  </Button>
                </Show>
                <p class="text-text-weak">{text().review}</p>
                <For each={["environment", "events", "errors"] as const}>
                  {(key) => (
                    <label class="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={state.include[key]}
                        onChange={(event) => setState("include", key, event.currentTarget.checked)}
                      />
                      {text()[key]}
                    </label>
                  )}
                </For>
                <Show when={state.context.model || state.context.provider}>
                  <label>
                    <input
                      type="checkbox"
                      checked={state.modelNames}
                      onChange={(event) => setState("modelNames", event.currentTarget.checked)}
                    />{" "}
                    {text().modelNames}
                  </label>
                </Show>
                <Show when={state.error}>
                  <label>
                    <input
                      type="checkbox"
                      checked={state.details}
                      onChange={(event) => setState("details", event.currentTarget.checked)}
                    />{" "}
                    {text().details}
                  </label>
                </Show>
                <label>
                  <input
                    type="checkbox"
                    disabled={!state.readConversation}
                    checked={state.conversation !== undefined}
                    onChange={(event) =>
                      setState("conversation", event.currentTarget.checked ? state.readConversation?.() : undefined)
                    }
                  />{" "}
                  {text().conversation}
                </label>
                <label>
                  {text().code}
                  <input
                    type="file"
                    disabled={state.pending}
                    accept="text/*,.ts,.tsx,.js,.json,.md,.py,.rs"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      if (!file) return
                      const generation = state.generation
                      void perform(async () => {
                        if (file.size > 32_000) throw new Error("Text too large")
                        const code = await file.text()
                        if (state.open && state.generation === generation && !state.preview) setState("code", code)
                        return ""
                      })
                      event.currentTarget.value = ""
                    }}
                  />
                </label>
                <Show when={state.code !== undefined}>
                  <Button variant="ghost" onClick={() => setState("code", undefined)}>
                    {text().remove} {text().code}
                  </Button>
                </Show>
                <label>
                  {text().screenshot}
                  <input
                    type="file"
                    disabled={state.pending}
                    accept="image/png"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      if (file) void perform(() => chooseImage(file))
                      event.currentTarget.value = ""
                    }}
                  />
                </label>
                <Show when={state.image}>
                  <p>{text().image}</p>
                  <img src={state.image} alt={text().screenshot} class="max-h-64 object-contain" />
                  <Button variant="ghost" onClick={() => setState("image", undefined)}>
                    {text().remove} {text().screenshot}
                  </Button>
                </Show>
                <Show when={state.busy}>
                  <p role="status">{text().busy}</p>
                </Show>
                <Button disabled={state.pending} onClick={freeze}>
                  {text().continue}
                </Button>
              </Show>
              <Show when={state.notice}>
                <p role="status">{state.notice}</p>
              </Show>
            </div>
          </Dialog>
        </div>
      </Kobalte.Portal>
    </Kobalte>
  )
}
