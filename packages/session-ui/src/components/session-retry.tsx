import { createMemo, Show } from "solid-js"
import type { SessionStatus } from "@zaovra-ai/sdk/v2/client"
import { useI18n } from "@zaovra-ai/ui/context/i18n"
import { Spinner } from "@zaovra-ai/ui/spinner"

export function SessionRetry(props: { status: SessionStatus; show?: boolean }) {
  const i18n = useI18n()
  const retry = createMemo(() => (props.status.type === "retry" ? props.status : undefined))

  return (
    <Show when={retry() && (props.show ?? true)}>
      <div
        data-slot="session-turn-retry"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        class="flex items-center gap-2 py-1 text-12-regular text-text-weak"
      >
        <Spinner class="size-3 shrink-0" />
        <span>
          {i18n.t("ui.sessionTurn.retry.attemptLine", {
            line: i18n.t("ui.sessionTurn.retry.retrying"),
            attempt: retry()?.attempt ?? 1,
          })}
        </span>
      </div>
    </Show>
  )
}
