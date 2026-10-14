import { For, Show, createEffect, createMemo, onCleanup, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@zaovra-ai/ui/button"
import { DockPrompt } from "@zaovra-ai/session-ui/dock-prompt"
import { Icon } from "@zaovra-ai/ui/icon"
import { useSpring } from "@zaovra-ai/ui/motion-spring"
import { showToast } from "@/utils/toast"
import type { QuestionAnswer, QuestionView } from "@zaovra-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useServerSDK } from "@/context/server-sdk"
import { questionOptions } from "@/utils/question-options"
import { ScopedKey } from "@/utils/server-scope"

const cache = new Map<string, { tab: number; answers: QuestionAnswer[]; custom: string[]; customOn: boolean[] }>()

function Mark(props: { multi: boolean; picked: boolean; onClick?: (event: MouseEvent) => void }) {
  return (
    <span data-slot="question-option-check" aria-hidden="true" onClick={props.onClick}>
      <span data-slot="question-option-box" data-type={props.multi ? "checkbox" : "radio"} data-picked={props.picked}>
        <Show when={props.multi} fallback={<span data-slot="question-option-radio-dot" />}>
          <Icon name="check-small" size="small" />
        </Show>
      </span>
    </span>
  )
}

function Option(props: {
  multi: boolean
  picked: boolean
  number: number
  recommended?: string
  label: string
  description?: string
  disabled: boolean
  ref?: (el: HTMLButtonElement) => void
  onFocus?: VoidFunction
  onClick: VoidFunction
}) {
  return (
    <button
      type="button"
      ref={props.ref}
      data-slot="question-option"
      data-picked={props.picked}
      role={props.multi ? "checkbox" : "radio"}
      aria-checked={props.picked}
      disabled={props.disabled}
      onFocus={props.onFocus}
      onClick={props.onClick}
    >
      <span data-slot="question-option-number" aria-hidden="true">
        {props.number}
      </span>
      <Mark multi={props.multi} picked={props.picked} />
      <span data-slot="question-option-main">
        <span data-slot="option-label">
          {props.label}
          <Show when={props.recommended}>
            <span data-slot="question-recommended">{props.recommended}</span>
          </Show>
        </span>
        <Show when={props.description}>
          <span data-slot="option-description">{props.description}</span>
        </Show>
      </span>
    </button>
  )
}

export const SessionQuestionDock: Component<{ request: QuestionView; onSubmit: () => void }> = (props) => {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const language = useLanguage()
  const cacheKey = ScopedKey.from(serverSDK().scope, props.request.id)

  const questions = createMemo(() => props.request.questions)
  const total = createMemo(() => questions().length)

  const cached = cache.get(cacheKey)
  const [store, setStore] = createStore({
    tab: cached?.tab ?? 0,
    answers: cached?.answers ?? ([] as QuestionAnswer[]),
    custom: cached?.custom ?? ([] as string[]),
    customOn: cached?.customOn ?? ([] as boolean[]),
    editing: false,
    focus: 0,
    minimized: false,
    optionsHeight: 180,
  })

  let root: HTMLDivElement | undefined
  let optionsRef: HTMLDivElement | undefined
  let customRef: HTMLTextAreaElement | undefined
  let optsRef: HTMLButtonElement[] = []
  let replied = false
  let mounted = true
  let focusFrame: number | undefined

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => questionOptions(question()?.options ?? []))
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const on = createMemo(() => store.customOn[store.tab] === true)
  const multi = createMemo(() => question()?.multiple === true)
  const count = createMemo(() => options().length + 1)

  const summary = createMemo(() => {
    const n = Math.min(store.tab + 1, total())
    return language.t("session.question.progress", { current: n, total: total() })
  })
  const customLabel = () => language.t("ui.messagePart.option.typeOwnAnswer")

  const last = createMemo(() => store.tab >= total() - 1)
  const collapse = useSpring(() => (store.minimized ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const hidden = createMemo(() => Math.max(0, Math.min(1, collapse())))
  const optionsOff = createMemo(() => hidden() > 0.98)

  const customUpdate = (value: string, selected: boolean = on()) => {
    const prev = input().trim()
    const next = value.trim()

    setStore("custom", store.tab, value)
    if (!selected) return

    if (multi()) {
      setStore("answers", store.tab, (current = []) => {
        const removed = prev ? current.filter((item) => item.trim() !== prev) : current
        if (!next) return removed
        if (removed.some((item) => item.trim() === next)) return removed
        return [...removed, next]
      })
      return
    }

    setStore("answers", store.tab, next ? [next] : [])
  }

  const measure = () => {
    if (!root) return

    const scroller = document.querySelector(".scroll-view__viewport")
    const head = scroller instanceof HTMLElement ? scroller.firstElementChild : undefined
    const top =
      head instanceof HTMLElement && head.classList.contains("sticky") ? head.getBoundingClientRect().bottom : 0
    if (!top) {
      root.style.removeProperty("--question-prompt-max-height")
      return
    }

    const dock = root.closest('[data-component="session-prompt-dock"]')
    if (!(dock instanceof HTMLElement)) return

    const dockBottom = dock.getBoundingClientRect().bottom
    const below = Math.max(0, dockBottom - root.getBoundingClientRect().bottom)
    const gap = 8
    const max = Math.max(240, Math.floor(dockBottom - top - gap - below))
    root.style.setProperty("--question-prompt-max-height", `${max}px`)
  }

  const clamp = (i: number) => Math.max(0, Math.min(count() - 1, i))

  const pickFocus = (tab: number = store.tab) => {
    const list = questionOptions(questions()[tab]?.options ?? [])
    if (store.customOn[tab] === true) return list.length
    return Math.max(
      0,
      list.findIndex((item) => store.answers[tab]?.includes(item.label) ?? false),
    )
  }

  const focus = (i: number) => {
    const next = clamp(i)
    setStore("focus", next)
    if (store.editing) return
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined
      if (store.editing) return
      const el = next === options().length ? customRef : optsRef[next]
      el?.focus()
    })
  }

  onMount(() => {
    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        measure()
      })
    }

    update()

    makeEventListener(window, "resize", update)

    const dock = root?.closest('[data-component="session-prompt-dock"]')
    const scroller = document.querySelector(".scroll-view__viewport")
    createResizeObserver([dock, scroller], update)

    onCleanup(() => {
      if (raf !== undefined) cancelAnimationFrame(raf)
    })

    if (!document.activeElement || document.activeElement === document.body || root?.contains(document.activeElement)) {
      focus(pickFocus())
    }
  })

  createEffect(() => {
    const el = optionsRef
    if (!el) return
    const update = () => setStore("optionsHeight", (height) => Math.max(height, el.scrollHeight))
    update()
    createResizeObserver(el, update)
  })

  onCleanup(() => {
    mounted = false
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    if (replied) return
    cache.set(cacheKey, {
      tab: store.tab,
      answers: store.answers.map((a) => (a ? [...a] : [])),
      custom: store.custom.map((s) => s ?? ""),
      customOn: store.customOn.map((b) => b ?? false),
    })
  })

  const fail = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    showToast({ title: language.t("common.requestFailed"), description: message })
  }

  const replyMutation = useMutation(() => ({
    mutationFn: (answers: QuestionAnswer[]) =>
      sdk().client.v2.session.question.reply(
        {
          sessionID: props.request.sessionID,
          requestID: props.request.id,
          questionV2Reply: { answers },
        },
        { throwOnError: true },
      ),
    onSuccess: () => {
      replied = true
      cache.delete(cacheKey)
      if (mounted) props.onSubmit()
    },
    onError: fail,
  }))

  const rejectMutation = useMutation(() => ({
    mutationFn: () =>
      sdk().client.v2.session.question.reject(
        {
          sessionID: props.request.sessionID,
          requestID: props.request.id,
        },
        { throwOnError: true },
      ),
    onSuccess: () => {
      replied = true
      cache.delete(cacheKey)
      if (mounted) props.onSubmit()
    },
    onError: fail,
  }))

  const sending = createMemo(() => replyMutation.isPending || rejectMutation.isPending)

  const reply = (answers: QuestionAnswer[]) => {
    if (sending()) return
    replyMutation.mutate(answers)
  }

  const reject = () => {
    if (sending()) return
    rejectMutation.mutate()
  }

  const submit = () => void reply(questions().map((_, i) => store.answers[i] ?? []))

  const picked = (answer: string) => store.answers[store.tab]?.includes(answer) ?? false

  const pick = (answer: string, custom: boolean = false) => {
    setStore("answers", store.tab, [answer])
    if (custom) setStore("custom", store.tab, answer)
    if (!custom) setStore("customOn", store.tab, false)
    setStore("editing", false)
  }

  const toggle = (answer: string) => {
    setStore("answers", store.tab, (current = []) => {
      if (current.includes(answer)) return current.filter((item) => item !== answer)
      return [...current, answer]
    })
  }

  const customToggle = () => {
    if (sending()) return
    setStore("focus", options().length)

    if (!multi()) {
      setStore("customOn", store.tab, true)
      setStore("editing", true)
      customUpdate(input(), true)
      customRef?.focus()
      return
    }

    const next = !on()
    setStore("customOn", store.tab, next)
    if (next) {
      setStore("editing", true)
      customUpdate(input(), true)
      customRef?.focus()
      return
    }

    const value = input().trim()
    if (value) setStore("answers", store.tab, (current = []) => current.filter((item) => item.trim() !== value))
    setStore("editing", false)
    focus(options().length)
  }

  const customOpen = () => {
    if (sending()) return
    setStore("focus", options().length)
    if (!on()) setStore("customOn", store.tab, true)
    setStore("editing", true)
    customUpdate(input(), true)
    customRef?.focus()
  }

  const move = (step: number) => {
    if (store.editing || sending()) return
    focus(store.focus + step)
  }

  const nav = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return

    if (event.key === "Escape") {
      event.preventDefault()
      void reject()
      return
    }

    const mod = (event.metaKey || event.ctrlKey) && !event.altKey
    if (mod && event.key === "Enter") {
      if (event.repeat) return
      event.preventDefault()
      next()
      return
    }

    const target =
      event.target instanceof HTMLElement ? event.target.closest('[data-slot="question-options"]') : undefined
    if (store.editing) return
    if (!(target instanceof HTMLElement)) return
    if (event.altKey || event.ctrlKey || event.metaKey) return

    if (/^[1-9]$/.test(event.key) && !event.repeat) {
      const index = Number(event.key) - 1
      if (index >= options().length) return
      event.preventDefault()
      selectOption(index)
      focus(index)
      return
    }
    if (event.key === "Enter" && !event.repeat) {
      event.preventDefault()
      if (!multi()) selectOption(store.focus)
      next()
      return
    }

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault()
      move(1)
      return
    }

    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault()
      move(-1)
      return
    }

    if (event.key === "Home") {
      event.preventDefault()
      focus(0)
      return
    }

    if (event.key !== "End") return
    event.preventDefault()
    focus(count() - 1)
  }

  const selectOption = (optIndex: number) => {
    if (sending()) return

    if (optIndex === options().length) {
      customOpen()
      return
    }

    const opt = options()[optIndex]
    if (!opt) return
    if (multi()) {
      setStore("editing", false)
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  const commitCustom = () => {
    setStore("editing", false)
    customUpdate(input())
    focus(options().length)
  }

  const resizeInput = (el: HTMLTextAreaElement) => {
    el.style.height = "0px"
    el.style.height = `${el.scrollHeight}px`
  }

  const next = () => {
    if (sending()) return
    if (store.editing) commitCustom()

    if (store.tab >= total() - 1) {
      submit()
      return
    }

    const tab = store.tab + 1
    setStore("tab", tab)
    setStore("editing", false)
    if (!store.minimized) focus(pickFocus(tab))
  }

  const back = () => {
    if (sending()) return
    if (store.tab <= 0) return
    const tab = store.tab - 1
    setStore("tab", tab)
    setStore("editing", false)
    if (!store.minimized) focus(pickFocus(tab))
  }

  const minimize = () => {
    if (sending()) return
    setStore("editing", false)
    setStore("minimized", true)
  }

  const restore = () => {
    if (sending()) return
    setStore("minimized", false)
    focus(pickFocus())
  }

  return (
    <div data-component="session-question-dock" data-notification-target={`question:${props.request.id}`}>
      <DockPrompt
        kind="question"
        ref={(el) => (root = el)}
        onKeyDown={nav}
        header={
          <>
            <button
              type="button"
              data-slot="question-header-title"
              disabled={sending()}
              onClick={store.minimized ? restore : minimize}
              aria-label={language.t(store.minimized ? "session.question.restore" : "session.question.minimize")}
            >
              <Icon name="bubble-5" size="small" />
              {language.t("notification.question.title")}
            </button>
            <div data-slot="question-header-actions">
              <Button
                variant="ghost"
                size="normal"
                disabled={sending() || store.tab === 0}
                onClick={back}
                aria-label={language.t("ui.common.back")}
              >
                <Icon name="chevron-left" size="small" />
              </Button>
              <span data-slot="question-page" aria-label={summary()}>
                {store.tab + 1}/{total()}
              </span>
              <Button
                variant="ghost"
                size="normal"
                disabled={sending() || last()}
                onClick={next}
                aria-label={language.t("ui.common.next")}
              >
                <Icon name="chevron-right" size="small" />
              </Button>
              <Button
                variant="ghost"
                size="normal"
                disabled={sending()}
                onClick={reject}
                aria-label={language.t("common.close")}
              >
                <Icon name="close" size="small" />
              </Button>
            </div>
          </>
        }
        footer={
          <>
            <div data-slot="question-footer-actions">
              <Button variant="ghost" size="large" disabled={sending()} onClick={reject} aria-keyshortcuts="Escape">
                {language.t("session.question.skip")}
              </Button>
              <Button
                variant={last() ? "primary" : "secondary"}
                size="large"
                disabled={sending()}
                onClick={next}
                aria-keyshortcuts="Meta+Enter Control+Enter"
              >
                {last() ? language.t("ui.common.submit") : language.t("ui.common.next")}
              </Button>
            </div>
          </>
        }
      >
        <div
          data-slot="question-text"
          style={{
            display: store.minimized ? "-webkit-box" : undefined,
            "-webkit-line-clamp": store.minimized ? "3" : undefined,
            "-webkit-box-orient": store.minimized ? "vertical" : undefined,
            overflow: store.minimized ? "hidden" : undefined,
          }}
        >
          {question()?.question}
        </div>
        <Show when={!store.minimized}>
          <Show when={multi()} fallback={<div data-slot="question-hint">{language.t("ui.question.singleHint")}</div>}>
            <div data-slot="question-hint">{language.t("ui.question.multiHint")}</div>
          </Show>
        </Show>
        <div
          ref={(el) => (optionsRef = el)}
          data-slot="question-options"
          aria-hidden={store.minimized || optionsOff() ? "true" : undefined}
          classList={{ "pointer-events-none": hidden() > 0.1 }}
          style={{
            "max-height": `${Math.max(0, store.optionsHeight * (1 - hidden()))}px`,
            opacity: `${Math.max(0, Math.min(1, 1 - hidden()))}`,
            visibility: optionsOff() ? "hidden" : "visible",
          }}
        >
          <For each={options()}>
            {(opt, i) => (
              <Option
                multi={multi()}
                picked={picked(opt.label)}
                number={i() + 1}
                recommended={opt.recommended ? language.t("session.question.recommended") : undefined}
                label={opt.displayLabel}
                description={opt.description}
                disabled={sending()}
                ref={(el) => (optsRef[i()] = el)}
                onFocus={() => setStore("focus", i())}
                onClick={() => selectOption(i())}
              />
            )}
          </For>

          <div data-slot="question-option" data-custom="true" data-picked={on()}>
            <button
              type="button"
              data-slot="question-custom-toggle"
              role={multi() ? "checkbox" : "radio"}
              aria-checked={on()}
              aria-label={customLabel()}
              disabled={sending()}
              onClick={customToggle}
            >
              <Mark multi={multi()} picked={on()} />
            </button>
            <textarea
              ref={customRef}
              data-slot="question-custom-input"
              aria-label={customLabel()}
              placeholder={language.t("session.question.custom")}
              value={input()}
              rows={1}
              disabled={sending()}
              onFocus={() => {
                setStore("focus", options().length)
                setStore("editing", true)
              }}
              onBlur={() => setStore("editing", false)}
              onKeyDown={(e) => {
                if (e.isComposing || e.keyCode === 229) return
                if (e.key === "Escape") {
                  e.preventDefault()
                  setStore("editing", false)
                  focus(0)
                  return
                }
                if (e.key !== "Enter" || e.shiftKey || e.repeat) return
                e.preventDefault()
                next()
              }}
              onInput={(e) => {
                setStore("customOn", store.tab, true)
                customUpdate(e.currentTarget.value, true)
                resizeInput(e.currentTarget)
              }}
            />
          </div>
        </div>
      </DockPrompt>
    </div>
  )
}
