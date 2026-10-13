import { Show } from "solid-js"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { executionErrorKind } from "@/utils/execution-error"

export function ExecutionErrorCard(props: {
  detail: string
  onConfigure?: () => void
  children?: import("solid-js").JSX.Element
}) {
  const language = useLanguage()
  const kind = () => executionErrorKind(props.detail)
  return (
    <section data-component="execution-error-card" role="alert">
      <h3>{language.t("common.requestFailed")}</h3>
      <p>{kind() ? language.t(`error.execution.${kind()!}`) : language.t("error.execution.unknown")}</p>
      <div class="flex flex-wrap items-center gap-2">
        <Show when={props.onConfigure}>
          <ButtonV2 variant="outline" onClick={() => props.onConfigure?.()}>
            {language.t("settings.providers.title")}
          </ButtonV2>
        </Show>
        {props.children}
      </div>
      <details>
        <summary>{language.t("session.outcome.details")}</summary>
        <pre class="whitespace-pre-wrap break-words select-text">{props.detail}</pre>
      </details>
    </section>
  )
}
