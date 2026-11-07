import { For, Show } from "solid-js"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import type { Session } from "@zaovra-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { sessionTitle } from "@/utils/session-title"

export function SessionStartOptions(props: {
  recent: Session[]
  disabled: boolean
  failed?: boolean
  onRetry: () => void
  onOpen: (session: Session) => void
  onSuggest: (text: string) => void
}) {
  const language = useLanguage()
  return (
    <div data-component="session-start-options" class="mt-5 flex flex-col gap-5">
      <div class="flex flex-wrap justify-center gap-1.5" aria-label={language.t("session.start.suggestions")}>
        <For each={["explain", "bug", "tests"] as const}>
          {(key) => (
            <ButtonV2
              size="small"
              variant="ghost-muted"
              disabled={props.disabled}
              onClick={() => props.onSuggest(language.t(`session.start.${key}.prompt`))}
            >
              {language.t(`session.start.${key}.label`)}
            </ButtonV2>
          )}
        </For>
      </div>
      <Show when={props.recent.length || props.failed}>
        <section aria-label={language.t("session.start.recent")}>
          <h2 class="mb-1 px-2 text-xs font-medium text-v2-text-text-muted">{language.t("session.start.recent")}</h2>
          <Show when={props.failed}>
            <ButtonV2 size="small" variant="ghost-muted" onClick={props.onRetry}>
              {language.t("sidebar.sessionsRetry")}
            </ButtonV2>
          </Show>
          <ul class="flex flex-col gap-0.5">
            <For each={props.recent}>
              {(session) => (
                <li>
                  <button
                    type="button"
                    data-session-id={session.id}
                    class="w-full truncate rounded-md px-2 py-1.5 text-left text-sm text-v2-text-text-base hover:bg-v2-background-bg-layer-02 focus-visible:outline-2 focus-visible:outline-v2-border-border-focus"
                    title={sessionTitle(session.title, language)}
                    onClick={() => props.onOpen(session)}
                  >
                    {sessionTitle(session.title, language)}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
    </div>
  )
}
