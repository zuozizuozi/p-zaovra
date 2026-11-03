import { Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useI18n } from "@zaovra-ai/ui/context/i18n"

export function ReasoningBlock(props: { text: string; streaming: boolean; children: JSX.Element }) {
  const i18n = useI18n()
  const [state, setState] = createStore({ open: false })
  const summary = () =>
    props.text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.replace(/^[#*\s]+|[*#]+$/g, "")
      .slice(0, 120) ?? ""
  return (
    <details
      data-component="reasoning-block"
      open={state.open}
      onToggle={(event) => setState("open", event.currentTarget.open)}
    >
      <summary
        class="flex h-7 min-w-0 cursor-pointer items-center gap-2 text-xs text-text-weak"
        aria-expanded={state.open}
      >
        <span class="shrink-0">{state.open ? "⌃" : "⌄"}</span>
        <span class="shrink-0">{i18n.t(props.streaming ? "ui.reasoning.active" : "ui.reasoning.completed")}</span>
        <span class="min-w-0 truncate" data-slot="reasoning-summary">
          {summary()}
        </span>
      </summary>
      <Show when={state.open}>{props.children}</Show>
    </details>
  )
}
