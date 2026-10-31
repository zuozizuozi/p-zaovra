import { createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@zaovra-ai/ui/button"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export function SettingsSessionBudget() {
  const sync = useServerSync()
  const language = useLanguage()
  const [state, setState] = createStore({
    tokens: "",
    minutes: "720",
    pending: false,
    dirty: false,
    tokenDirty: false,
    durationDirty: false,
  })
  createEffect(() => {
    const config = sync().data.config
    if (state.dirty) return
    setState({
      tokens: config.session_token_budget == null ? "" : String(config.session_token_budget),
      minutes: config.session_duration_ms === null ? "" : String((config.session_duration_ms ?? 43_200_000) / 60_000),
    })
  })
  const save = async () => {
    const tokens = state.tokens.trim() ? Number(state.tokens) : null
    const duration = state.minutes.trim() ? Number(state.minutes) * 60_000 : null
    if ([tokens, duration].some((value) => value !== null && (!Number.isSafeInteger(value) || value <= 0))) {
      showToast({ title: language.t("session.budget.invalid") })
      return
    }
    setState("pending", true)
    await sync()
      .updateConfig({
        ...(state.tokenDirty ? { session_token_budget: tokens } : {}),
        ...(state.durationDirty ? { session_duration_ms: duration } : {}),
      })
      .then(() => setState({ dirty: false, tokenDirty: false, durationDirty: false }))
      .catch((error: unknown) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setState("pending", false))
  }
  return (
    <section data-component="settings-session-budget" class="flex flex-col gap-3 py-4 text-12-regular">
      <h3 class="font-medium">{language.t("session.budget.defaults")}</h3>
      <p class="text-text-weak">{language.t("session.budget.defaultHint")}</p>
      <div class="flex flex-wrap items-end gap-3">
        <label>
          {language.t("session.budget.tokens")}
          <input
            class="ml-2 w-28 rounded border border-border-base px-2 py-1 tabular-nums"
            type="number"
            min="1"
            step="1"
            disabled={state.pending}
            value={state.tokens}
            placeholder={
              sync().data.config.session_token_budget === undefined
                ? language.t("session.budget.modeDefaults")
                : language.t("session.budget.unlimited")
            }
            onInput={(event) => setState({ tokens: event.currentTarget.value, dirty: true, tokenDirty: true })}
          />
        </label>
        <label>
          {language.t("session.budget.minutes")}
          <input
            class="ml-2 w-28 rounded border border-border-base px-2 py-1 tabular-nums"
            type="number"
            min="1"
            step="1"
            disabled={state.pending}
            value={state.minutes}
            onInput={(event) => setState({ minutes: event.currentTarget.value, dirty: true, durationDirty: true })}
          />
        </label>
        <Button size="small" disabled={state.pending || !state.dirty} onClick={() => void save()}>
          {language.t("session.budget.save")}
        </Button>
      </div>
    </section>
  )
}
