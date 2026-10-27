import type { AssistantMessage, ToolPart } from "@zaovra-ai/sdk/v2"
import { useI18n } from "@zaovra-ai/ui/context/i18n"
import { Show, createMemo } from "solid-js"

export function settledTurnStatus(messages: readonly AssistantMessage[], unresolved: boolean) {
  const last = messages.at(-1)
  if (last?.finish === "stopped") return "stopped"
  if (last?.finish === "interrupted" || last?.error?.name === "MessageAbortedError") return "interrupted"
  if (last?.error || unresolved) return "error"
}

export function TurnProcessSummary(props: {
  seconds?: number
  tools: readonly ToolPart[]
  status?: ReturnType<typeof settledTurnStatus>
  folded: boolean
  onToggle: () => void
}) {
  const i18n = useI18n()
  const counts = createMemo(() => {
    const tools = props.tools.filter((part) => !["todowrite", "question"].includes(part.tool))
    const edits = tools.filter((part) => ["edit", "write", "apply_patch"].includes(part.tool)).length
    const commands = tools.filter((part) => ["bash", "bash_job"].includes(part.tool)).length
    const other = tools.length - edits - commands
    const failed = tools.filter((part) => part.state.status === "error").length
    return [
      [
        edits && i18n.t("session.process.edit", { count: edits }),
        commands && i18n.t("session.process.command", { count: commands }),
        other && i18n.t("session.process.other", { count: other }),
      ]
        .filter(Boolean)
        .join(i18n.t("session.process.separator")),
      failed ? i18n.t("session.process.failed", { count: failed }) : "",
    ].join("")
  })
  return (
    <div data-component="turn-process-summary" class="text-xs text-text-weak min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <Show when={props.status}>
          {(status) => <span data-slot="turn-terminal-status">{i18n.t(`session.turn.${status()}`)}</span>}
        </Show>
        <button type="button" aria-expanded={!props.folded} onClick={props.onToggle}>
          {props.seconds === undefined
            ? i18n.t("session.process.details")
            : i18n.t("session.turn.duration", { seconds: props.seconds })}{" "}
          {props.folded ? "⌄" : "⌃"}
        </button>
      </div>
      <Show when={counts()}>
        <button
          data-slot="process-counts"
          class="text-left break-words"
          type="button"
          aria-expanded={!props.folded}
          onClick={props.onToggle}
        >
          {counts()}
        </button>
      </Show>
    </div>
  )
}
