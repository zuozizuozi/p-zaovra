import { createEffect, createMemo, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createQuery } from "@tanstack/solid-query"
import type { AssistantMessage } from "@zaovra-ai/sdk/v2"
import { Button } from "@zaovra-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export function SessionRecovery(props: { message: AssistantMessage; active: boolean }) {
  const sdk = useSDK()
  const server = useServerSDK()
  const sync = useServerSync()
  const language = useLanguage()
  const selection = createMemo(() => ({
    client: sdk().client,
    scope: server().scope,
    sessionID: props.message.sessionID,
    messageID: props.message.id,
    active: props.active,
  }))
  const [state, setState] = createStore({
    tokens: "",
    minutes: "",
    dirty: false,
    pending: false,
    sent: false,
    error: "",
  })
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  createEffect(() => {
    selection()
    setState({ tokens: "", minutes: "", dirty: false, pending: false, sent: false, error: "" })
  })
  const outcome = createQuery(
    () => {
      const current = selection()
      return {
        queryKey: ["session-recovery-outcome", current.scope, current.sessionID, current.messageID],
        enabled: current.active,
        queryFn: () =>
          current.client.v2.session
            .outcome({ sessionID: current.sessionID }, { throwOnError: true })
            .then((result) => result.data.data),
        retry: false,
      }
    },
    () => sync().queryClient,
  )
  const terminal = () => {
    const current = outcome.data
    if (current?.messageID !== props.message.id) return
    return current.state === "failed" || current.state === "stopped" || current.state === "interrupted"
      ? current
      : undefined
  }
  const budgetStop = () => terminal()?.termination?.category === "budget"
  const failed = () =>
    terminal()?.state === "failed" || (!!props.message.error && props.message.error.name !== "MessageAbortedError")
  const budget = createQuery(
    () => {
      const current = selection()
      return {
        queryKey: ["session-recovery-budget", current.scope, current.sessionID, current.messageID],
        enabled: current.active && budgetStop(),
        queryFn: () =>
          current.client.v2.session
            .budget({ sessionID: current.sessionID }, { throwOnError: true })
            .then((result) => result.data.data),
        retry: false,
      }
    },
    () => sync().queryClient,
  )
  createEffect(() => {
    const current = budget.data
    if (!current || state.dirty) return
    setState({
      tokens:
        current.limits.tokens === undefined
          ? ""
          : String(
              current.used.tokens >= current.limits.tokens
                ? Math.ceil(current.used.tokens * 1.25)
                : current.limits.tokens,
            ),
      minutes:
        current.limits.durationMs === undefined
          ? ""
          : String(
              current.used.durationMs >= current.limits.durationMs
                ? Math.ceil(current.used.durationMs / 60_000) + 30
                : current.limits.durationMs / 60_000,
            ),
    })
  })
  const resume = async () => {
    const current = selection()
    if (!current.active || state.pending || state.sent || !terminal() || outcome.isFetching) return
    const status = budget.data
    const tokens = state.tokens.trim() ? Number(state.tokens) : undefined
    const durationMs = state.minutes.trim() ? Number(state.minutes) * 60_000 : undefined
    if (
      budgetStop() &&
      (!status ||
        budget.isFetching ||
        [tokens, durationMs].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) ||
        (status.limits.tokens !== undefined &&
          (tokens === undefined || tokens <= status.used.tokens || tokens < status.limits.tokens)) ||
        (status.limits.durationMs !== undefined &&
          (durationMs === undefined ||
            durationMs <= status.used.durationMs ||
            durationMs < status.limits.durationMs)) ||
        !(
          (tokens !== undefined && (status.limits.tokens === undefined || tokens > status.limits.tokens)) ||
          (durationMs !== undefined &&
            (status.limits.durationMs === undefined || durationMs > status.limits.durationMs))
        ))
    ) {
      setState("error", language.t("session.recovery.invalidBudget"))
      return
    }
    setState({ pending: true, error: "" })
    await (async () => {
      if (budgetStop()) {
        await current.client.v2.session.update(
          {
            sessionID: current.sessionID,
            budget: {
              ...(tokens === undefined ? {} : { tokens }),
              ...(durationMs === undefined ? {} : { durationMs }),
            },
          },
          { throwOnError: true },
        )
        if (disposed || selection() !== current) {
          showToast({ title: language.t("session.recovery.updatedWithoutContinue") })
          return
        }
      }
      if (disposed || selection() !== current) return
      await current.client.v2.session.recover(
        {
          sessionID: current.sessionID,
          messageID: current.messageID,
          action: "continue",
        },
        { throwOnError: true },
      )
      if (!disposed && selection() === current) setState("sent", true)
    })()
      .catch((error: unknown) => {
        if (!disposed && selection() === current)
          setState("error", error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!disposed && selection() === current) setState("pending", false)
      })
  }
  return (
    <Show when={budgetStop() || failed() || (props.active && outcome.isError)}>
      <section data-component="session-recovery" class="py-2 text-12-regular">
        <Show
          when={outcome.isError && props.active}
          fallback={
            <p class="text-text-weak">
              {language.t(budgetStop() ? "session.recovery.budgetStopped" : "session.recovery.failed")}
            </p>
          }
        >
          <p role="alert">{language.t("session.recovery.outcomeUnavailable")}</p>
          <Button size="small" onClick={() => void outcome.refetch()}>
            {language.t("common.retry")}
          </Button>
        </Show>
        <Show when={props.active && terminal() && !outcome.isError}>
          <Show
            when={budgetStop()}
            fallback={
              <Button class="mt-2" size="small" disabled={state.pending || state.sent} onClick={() => void resume()}>
                {language.t(state.sent ? "session.recovery.requested" : "session.recovery.continue")}
              </Button>
            }
          >
            <form
              data-component="session-budget-recovery"
              class="mt-2 rounded-lg border border-border-base p-3 flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                void resume()
              }}
            >
              <p>{language.t("session.recovery.budgetHint")}</p>
              <Show when={budget.isError}>
                <p role="alert">{language.t("session.recovery.budgetUnavailable")}</p>
                <Button size="small" type="button" onClick={() => void budget.refetch()}>
                  {language.t("common.retry")}
                </Button>
              </Show>
              <Show when={budget.data}>
                <div class="flex flex-wrap gap-3">
                  <label>
                    {language.t("session.budget.tokens")}
                    <input
                      class="ml-2 w-32 rounded border border-border-base px-2 py-1 tabular-nums"
                      type="number"
                      min="1"
                      step="1"
                      disabled={state.pending || state.sent}
                      value={state.tokens}
                      placeholder={language.t("session.budget.unlimited")}
                      onInput={(event) => setState({ tokens: event.currentTarget.value, dirty: true })}
                    />
                  </label>
                  <label>
                    {language.t("session.budget.minutes")}
                    <input
                      class="ml-2 w-24 rounded border border-border-base px-2 py-1 tabular-nums"
                      type="number"
                      min={1 / 60_000}
                      step="any"
                      disabled={state.pending || state.sent}
                      value={state.minutes}
                      placeholder={language.t("session.budget.unlimited")}
                      onInput={(event) => setState({ minutes: event.currentTarget.value, dirty: true })}
                    />
                  </label>
                </div>
                <Button size="small" type="submit" disabled={state.pending || state.sent || budget.isFetching}>
                  {language.t(state.sent ? "session.recovery.requested" : "session.recovery.increaseAndContinue")}
                </Button>
              </Show>
            </form>
          </Show>
          <Show when={state.error}>
            <p role="alert" class="mt-2 text-text-weak whitespace-pre-wrap break-words">
              {state.error}
            </p>
          </Show>
        </Show>
      </section>
    </Show>
  )
}
