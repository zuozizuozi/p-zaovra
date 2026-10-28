import { Show, type JSX } from "solid-js"
import { Popover } from "@zaovra-ai/ui/popover"
import { useI18n } from "@zaovra-ai/ui/context/i18n"

export function budgetAttention(
  budget?: {
    used: { tokens: number; durationMs: number }
    limits: { tokens?: number; durationMs?: number }
  },
  stopped = false,
) {
  return (
    stopped ||
    (!!budget &&
      ((budget.limits.tokens !== undefined && budget.used.tokens >= budget.limits.tokens * 0.8) ||
        (budget.limits.durationMs !== undefined && budget.used.durationMs >= budget.limits.durationMs * 0.8)))
  )
}

/** The settled turn has one disclosure row; an uneventful turn has no footer. */
export function SessionEndBar(props: {
  hasChanges: boolean
  changes?: JSX.Element
  passed: number
  notice?: string
  onUndo?: () => void
  children: JSX.Element
}) {
  const i18n = useI18n()
  return (
    <Show when={props.hasChanges || props.notice}>
      <div
        data-component="session-end-bar"
        class="flex h-7 min-w-0 items-center gap-2 text-xs text-text-weak"
        data-attention={props.notice ? "" : undefined}
      >
        <Show when={props.hasChanges}>{props.changes}</Show>
        <Popover
          triggerAs="button"
          triggerProps={{
            type: "button",
            class: "min-w-0 flex-1 truncate text-left",
            title: props.notice ?? i18n.t("session.end.details"),
          }}
          trigger={
            <span>
              {props.notice ??
                (props.passed ? i18n.t("session.end.checked", { count: props.passed }) : i18n.t("session.end.details"))}
            </span>
          }
          title={i18n.t("session.end.details")}
        >
          <div class="max-h-96 overflow-auto text-xs" data-component="session-end-details">
            {props.children}
          </div>
        </Popover>
        <Show when={props.hasChanges && props.onUndo}>
          <button type="button" class="shrink-0" onClick={() => props.onUndo?.()}>
            {i18n.t("session.end.undo")}
          </button>
        </Show>
      </div>
    </Show>
  )
}
