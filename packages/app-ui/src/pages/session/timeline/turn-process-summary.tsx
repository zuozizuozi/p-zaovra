import type { AssistantMessage, Part, ToolPart } from "@zaovra-ai/sdk/v2"
import { useI18n } from "@zaovra-ai/ui/context/i18n"
import { renderable } from "@zaovra-ai/session-ui/message-part"
import { Show, createMemo } from "solid-js"
import { turnPartFoldable } from "./turn-part-visibility"

export function hasTurnProcessContent(
  parts: readonly Part[],
  input: {
    answerMessageID?: string
    showReasoning: boolean
    coveredFailure: (partID: string) => boolean
    processes: number
  },
) {
  return (
    input.processes > 0 ||
    parts.some(
      (part) =>
        renderable(part, input.showReasoning) &&
        turnPartFoldable(part, {
          answer: part.messageID === input.answerMessageID,
          coveredFailure: input.coveredFailure(part.id),
        }),
    )
  )
}

export function settledTurnStatus(messages: readonly AssistantMessage[], unresolved: boolean, stopped = false) {
  const last = messages.at(-1)
  if (stopped) return "stopped"
  if (last?.finish === "stopped") return "stopped"
  if (last?.finish === "interrupted" || last?.error?.name === "MessageAbortedError") return "interrupted"
  if (last?.error || unresolved) return "error"
}

export function TurnProcessSummary(props: {
  seconds?: number
  tools: readonly ToolPart[]
  thoughts?: number
  processes?: number
  status?: ReturnType<typeof settledTurnStatus>
  working?: boolean
  hasContent?: boolean
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
        props.thoughts && i18n.t("session.process.thought", { count: props.thoughts }),
        edits && i18n.t("session.process.edit", { count: edits }),
        commands && i18n.t("session.process.command", { count: commands }),
        other && i18n.t("session.process.other", { count: other }),
        props.processes && i18n.t("session.process.record", { count: props.processes }),
      ]
        .filter(Boolean)
        .join(i18n.t("session.process.separator")),
      failed ? i18n.t("session.process.failed", { count: failed }) : "",
    ].join("")
  })
  return (
    <div data-component="turn-process-summary" class="flex h-9 min-w-0 items-center gap-2 text-xs text-text-weak">
      <Show when={!props.working && props.status}>
        {(status) => (
          <span data-slot="turn-terminal-status" class="shrink-0">
            {i18n.t(`session.turn.${status()}`)}
          </span>
        )}
      </Show>
      <Show
        when={props.hasContent ?? !!counts()}
        fallback={
          <Show when={props.seconds !== undefined}>
            <span>{i18n.t("session.turn.duration", { seconds: props.seconds! })}</span>
          </Show>
        }
      >
        <button
          type="button"
          class="flex h-9 min-w-0 items-center gap-2 text-left"
          aria-expanded={!props.folded}
          onClick={props.onToggle}
        >
          <Show when={counts()}>
            <span
              data-slot="process-counts"
              class="min-w-0 truncate"
              style={{ "font-variant-numeric": "tabular-nums" }}
            >
              {counts()}
            </span>
          </Show>
          <span class="shrink-0">
            {props.seconds === undefined
              ? counts()
                ? ""
                : i18n.t("session.process.details")
              : i18n.t("session.turn.duration", { seconds: props.seconds })}
          </span>
          <span aria-hidden="true" class="shrink-0">
            {props.folded ? "⌄" : "⌃"}
          </span>
        </button>
      </Show>
    </div>
  )
}
