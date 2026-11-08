import { TaskMascot } from "./task-mascot"
import { openFeedback } from "@/feedback"
import { Show } from "solid-js"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { executionErrorKind } from "@/utils/execution-error"

export function ExecutionErrorCard(props: {
  detail: string
  onConfigure?: () => void
  mascot?: boolean
  detailsOnly?: boolean
  children?: import("solid-js").JSX.Element
}) {
  const language = useLanguage()
  const kind = () => executionErrorKind(props.detail)
  return (
    <section
      data-component="execution-error-card"
      data-details-only={props.detailsOnly || undefined}
      role={props.detailsOnly ? undefined : "alert"}
    >
      <Show when={!props.detailsOnly}>
        <div class="flex items-center gap-2">
          <Show when={props.mascot !== false}>
            <TaskMascot state="error" />
          </Show>
          <h3>{kind() ? language.t(`error.title.${kind()!}`) : language.t("common.requestFailed")}</h3>
        </div>
        <p>{kind() ? language.t(`error.execution.${kind()!}`) : language.t("error.execution.unknown")}</p>
      </Show>
      <details>
        <summary>{language.t("session.outcome.details")}</summary>
        <pre class="whitespace-pre-wrap break-words select-text">{props.detail}</pre>
        <div class="flex flex-wrap items-center gap-2">
          <Show when={props.onConfigure}>
            <ButtonV2 variant="contrast" onClick={() => props.onConfigure?.()}>
              {language.t("error.checkModelService")}
            </ButtonV2>
          </Show>
          {props.children}
          <ButtonV2
            variant="ghost-muted"
            data-feedback-entry="error"
            onClick={() => openFeedback({ error: props.detail, configure: props.onConfigure })}
          >
            {language.locale().startsWith("zh") ? "反馈这个问题" : "Report this problem"}
          </ButtonV2>
          </div>
      </details>
    </section>
  )
}
