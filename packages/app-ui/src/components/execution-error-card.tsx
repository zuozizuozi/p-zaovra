import { TaskMascot } from "./task-mascot"
import { Show } from "solid-js"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { executionErrorKind } from "@/utils/execution-error"

export function ExecutionErrorCard(props: {
  detail: string
  onConfigure?: () => void
  recoveryID?: string
  children?: import("solid-js").JSX.Element
}) {
  const language = useLanguage()
  const kind = () => executionErrorKind(props.detail)
  return (
    <section data-component="execution-error-card" role="alert">
      <div class="flex items-center gap-2">
        <TaskMascot state="error" />
        <h3>{kind() ? language.t(`error.title.${kind()!}`) : language.t("common.requestFailed")}</h3>
      </div>
      <p>{kind() ? language.t(`error.execution.${kind()!}`) : language.t("error.execution.unknown")}</p>
      <div class="flex flex-wrap items-center gap-2">
        <Show when={props.onConfigure}>
          <ButtonV2 variant="contrast" onClick={() => props.onConfigure?.()}>
            {language.t("error.checkModelService")}
          </ButtonV2>
        </Show>
        {props.children}
        <span data-recovery-target={props.recoveryID} class="contents" />
      </div>
      <details>
        <summary>{language.t("session.outcome.details")}</summary>
        <pre class="whitespace-pre-wrap break-words select-text">{props.detail}</pre>
      </details>
    </section>
  )
}
