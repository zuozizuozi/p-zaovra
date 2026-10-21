import { For, Show, createMemo, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic, Portal } from "solid-js/web"
import { IconButton } from "@zaovra-ai/ui/icon-button"
import { useParams } from "@solidjs/router"
import { createQuery, useMutation } from "@tanstack/solid-query"
import { MenuV2 } from "@zaovra-ai/ui/v2/menu-v2"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import { Button } from "@zaovra-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { hasUnfinishedShell } from "@/context/v2-session-adapter"
import { showToast } from "@/utils/toast"
import { commandVerification, staleVerification } from "@/utils/verification-label"
import { artifactPath } from "@/utils/artifact-path"
import { visibleProgress } from "./visible-progress"

export function SessionOutcomeDock() {
  const params = useParams()
  const sdk = useSDK()
  const server = useServerSDK()
  const sync = useServerSync()
  const language = useLanguage()
  const prompt = usePrompt()
  const progress = createMemo(() =>
    visibleProgress({
      sessionID: params.id ?? "",
      messages: sync().session.data.message[params.id ?? ""] ?? [],
      parts: sync().session.data.part,
      busy: !!params.id && sync().session.data.session_working(params.id),
      waiting:
        (sync().session.data.permission[params.id ?? ""]?.length ?? 0) > 0 ||
        (sync().session.data.question[params.id ?? ""]?.length ?? 0) > 0,
    }),
  )
  const query = createQuery(() => {
    const id = params.id
    const messages = sync().session.data.message[id ?? ""] ?? []
    const last = messages.at(-1)
    const busy = !!id && sync().session.data.session_working(id)
    const client = sdk().client
    return {
      queryKey: [
        "session-outcome",
        server().scope,
        id,
        last?.id,
        last?.time,
        busy,
        hasUnfinishedShell(messages, sync().session.data.part),
      ],
      enabled: !!id && !busy,
      queryFn: () =>
        client.v2.session.outcome({ sessionID: id! }, { throwOnError: true }).then((result) => result.data.data),
      retry: false,
      staleTime: 0,
    }
  })
  const outcome = () => (query.isFetched ? query.data : undefined)
  // Coverage is owned by the host; never infer replacement from command text here.
  const currentChecks = createMemo(() => outcome()?.checks.filter((check) => !check.supersededBy) ?? [])
  const historicalChecks = createMemo(() => outcome()?.checks.filter((check) => !!check.supersededBy) ?? [])
  const stale = (check: ReturnType<typeof currentChecks>[number]) => staleVerification(check, outcome()?.missing ?? [])
  const staleChecks = createMemo(() => currentChecks().filter(stale).length)
  const passedChecks = createMemo(
    () => currentChecks().filter((check) => check.exit === 0 && !check.execution && !stale(check)).length,
  )
  const unresolvedChecks = createMemo(() => currentChecks().filter((check) => check.exit !== 0 && !check.execution))
  const failedChecks = () => unresolvedChecks().length
  const incompleteChecks = createMemo(() => currentChecks().filter((check) => !!check.execution).length)
  const recover = useMutation(() => ({
    mutationFn: (input: { sessionID: string; messageID: string; action: "continue" | "retry" | "abandon" }) =>
      sdk().client.v2.session.recover(input, { throwOnError: true }),
    onSuccess: () => void query.refetch(),
    onError: (error: unknown) =>
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  }))
  const abandoned = () =>
    !!sync().session.get(params.id ?? "")?.time.archived ||
    (recover.isSuccess && recover.variables?.sessionID === params.id && recover.variables.action === "abandon")
  const [budget, setBudget] = createStore({ tokens: "", minutes: "" })
  const updateBudget = useMutation(() => ({
    mutationFn: async (remove: boolean) => {
      const tokens = remove || !budget.tokens.trim() ? null : Number(budget.tokens)
      const durationMs = remove || !budget.minutes.trim() ? null : Number(budget.minutes) * 60_000
      if ([tokens, durationMs].some((value) => value !== null && (!Number.isSafeInteger(value) || value <= 0)))
        throw new Error(language.t("session.budget.invalid"))
      const sessionID = params.id!
      await sdk().client.v2.session.update(
        {
          sessionID,
          budget: { ...(tokens === null ? {} : { tokens }), ...(durationMs === null ? {} : { durationMs }) },
        },
        { throwOnError: true },
      )
      const terminal = outcome()
      if (terminal?.state === "stopped" && terminal.messageID)
        await sdk().client.v2.session.recover(
          { sessionID, messageID: terminal.messageID, action: "continue" },
          { throwOnError: true },
        )
    },
    onSuccess: () => void query.refetch(),
    onError: (error: unknown) =>
      showToast({
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  }))
  const [display, setDisplay] = createStore<{ target?: HTMLElement }>({})
  createEffect(() => {
    const messageID = outcome()?.messageID
    const message = sync().session.data.message[params.id ?? ""]?.find((item) => item.id === messageID)
    const id = message?.role === "assistant" ? message.parentID : messageID
    const update = () => {
      const target = id
        ? (document.querySelector<HTMLElement>(`[data-recovery-target="${CSS.escape(id)}"]`) ?? undefined)
        : undefined
      if (target !== display.target) setDisplay("target", target)
    }
    update()
    // A virtualized error card can mount after the outcome query, or leave the viewport.
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true })
    onCleanup(() => observer.disconnect())
  })
  return (
    <>
      <Show when={params.id && !abandoned()}>
        <details data-component="session-budget" class="px-1 py-2 text-12-regular text-text-weak">
          <summary>{language.t("session.budget.title")}</summary>
          <p>{language.t("session.budget.hint")}</p>
          <label>
            {language.t("session.budget.tokens")}
            <input
              type="number"
              min="1"
              step="1"
              value={budget.tokens}
              onInput={(event) => setBudget("tokens", event.currentTarget.value)}
            />
          </label>
          <label>
            {language.t("session.budget.minutes")}
            <input
              type="number"
              min="1"
              step="1"
              value={budget.minutes}
              onInput={(event) => setBudget("minutes", event.currentTarget.value)}
            />
          </label>
          <Button
            size="small"
            disabled={updateBudget.isPending || recover.isPending}
            onClick={() => updateBudget.mutate(false)}
          >
            {language.t("session.budget.apply")}
          </Button>
          <Button
            size="small"
            variant="ghost"
            disabled={updateBudget.isPending || recover.isPending}
            onClick={() => updateBudget.mutate(true)}
          >
            {language.t("session.budget.remove")}
          </Button>
        </details>
      </Show>
      <Show when={progress().visible}>
        <div data-component="session-live-progress" role="status" class="px-1 py-2 text-12-regular text-text-weak">
          <p class="break-words">
            <Show when={progress().target}>{progress().target} · </Show>
            {language.t(`session.progress.${progress().state}`)}
            <Show when={progress().tool}> · {progress().tool}</Show>
          </p>
          <p>
            <Show when={progress().fact}>{language.t("session.progress.returned", { tool: progress().fact! })} · </Show>
            {language.t("session.progress.updating")}
          </p>
          <details>
            <summary>{language.t("session.progress.details")}</summary>
            <p>{language.t("session.progress.usageUnknown")}</p>
            <For each={progress().facts}>
              {(fact) => (
                <p class="break-words">
                  {fact.tool} · {fact.duration} ms · {fact.id}
                </p>
              )}
            </For>
            <Show when={outcome()?.missing.length || unresolvedChecks().length || staleChecks() || incompleteChecks()}>
              <p>{language.t("session.progress.previousEvidence")}</p>
              <For each={outcome()?.missing}>{(missing) => <p>{missing}</p>}</For>
              <For each={unresolvedChecks()}>
                {(check) => (
                  <p class="break-words">
                    {check.command} · exit {check.exit}
                  </p>
                )}
              </For>
              <Show when={staleChecks()}>
                <p>{language.t("session.outcome.staleCount", { count: staleChecks() })}</p>
              </Show>
              <Show when={incompleteChecks()}>
                <p>{language.t("session.outcome.incompleteCount", { count: incompleteChecks() })}</p>
              </Show>
            </Show>
          </details>
          <Show when={progress().failures.length}>
            <details>
              <summary>{language.t("session.progress.failures", { count: progress().failures.length })}</summary>
              <For each={progress().failures}>
                {(failure) => (
                  <p class="break-words">
                    {failure.tool}: {failure.error}
                  </p>
                )}
              </For>
            </details>
          </Show>
        </div>
      </Show>
      <Show
        when={!query.isError}
        fallback={
          <div role="status" class="px-1 py-2 text-12-regular text-text-weak">
            {language.t("session.outcome.unavailable")}{" "}
            <Button size="small" variant="ghost" onClick={() => void query.refetch()}>
              {language.t("session.outcome.refresh")}
            </Button>
          </div>
        }
      >
        <Show
          when={
            outcome() &&
            outcome()?.state !== "idle" &&
            outcome()?.state !== "running" &&
            !sync().session.data.session_working(params.id ?? "")
          }
        >
          <div
            class="px-1 py-2 flex flex-col gap-1 text-12-regular text-text-weak"
            role="status"
            aria-busy={recover.isPending}
          >
            <Show when={outcome()?.termination}>
              <p data-component="session-termination">
                {language.t(`session.outcome.${outcome()!.state}`)} · {outcome()!.termination!.message}
              </p>
            </Show>
            <Show when={outcome()?.outcomeUnknown && !abandoned()}>
              <span role="alert" class="text-icon-critical-base font-medium">
                {language.t("session.outcome.unknown")}
              </span>
            </Show>
            <Show when={outcome()?.checks.length || outcome()?.missing.length}>
              <details data-component="verification-panel">
                <summary
                  class="font-medium cursor-pointer"
                  data-component="verification-summary"
                  data-warning={failedChecks() || staleChecks() || incompleteChecks() ? "" : undefined}
                >
                  {language.t(abandoned() ? "session.outcome.abandoned" : `session.outcome.${outcome()!.state}`)} ·{" "}
                  <Show when={currentChecks().length} fallback={language.t("session.outcome.noChecks")}>
                    {language.t("session.outcome.latestCount", { count: passedChecks() })}
                  </Show>
                </summary>
                <IconButton
                  icon="reset"
                  variant="ghost"
                  aria-label={language.t("session.outcome.refresh")}
                  title={language.t("session.outcome.refresh")}
                  disabled={query.isFetching || recover.isPending}
                  onClick={() => void query.refetch()}
                />
                <Show when={!outcome()?.checks.length && outcome()?.recentChecks?.length}>
                  <details data-component="verification-recent" class="text-text-weak">
                    <summary>{language.t("session.outcome.recent")}</summary>
                    <For each={outcome()?.recentChecks}>
                      {(item) => (
                        <div class="min-w-0 break-words" data-source-message={item.userMessageID}>
                          {language.t("session.outcome.recentSource", { turn: item.turn })}
                          {" · "}
                          {language.t(item.fresh ? "session.outcome.recentFresh" : "session.outcome.recentStale")}
                          {" · "}
                          {item.check.kind}
                          {" · "}
                          {item.check.command}
                        </div>
                      )}
                    </For>
                  </details>
                </Show>
                <Show when={outcome()?.checks.length || outcome()?.missing.length}>
                  <details data-component="verification-details">
                    <summary class="cursor-pointer text-text-weak">
                      {failedChecks()
                        ? language.t("session.outcome.earlierFailures", { count: failedChecks() })
                        : language.t("session.outcome.inspectChecks")}
                    </summary>
                    <details data-component="verification-explanation" class="py-1">
                      <summary>{language.t("session.outcome.explanation")}</summary>
                      <Show when={failedChecks()}>
                        <p>{language.t("session.outcome.unresolvedHint")}</p>
                      </Show>
                      <Show when={staleChecks()}>
                        <p>{language.t("session.outcome.staleCount", { count: staleChecks() })}</p>
                        <p>{language.t("session.outcome.staleHint")}</p>
                      </Show>
                      <Show when={incompleteChecks()}>
                        <p>{language.t("session.outcome.incompleteCount", { count: incompleteChecks() })}</p>
                      </Show>
                      <For each={outcome()?.missing}>
                        {(item) => <p>{item === "requirements" ? language.t("session.outcome.requirements") : item}</p>}
                      </For>
                    </details>
                    <For
                      each={[
                        {
                          history: false,
                          unresolved: false,
                          stale: false,
                          checks: currentChecks().filter(
                            (check) => (check.exit === 0 || !!check.execution) && !stale(check),
                          ),
                        },
                        { history: false, unresolved: true, stale: false, checks: unresolvedChecks() },
                        { history: false, unresolved: false, stale: true, checks: currentChecks().filter(stale) },
                        { history: true, unresolved: false, stale: false, checks: historicalChecks() },
                      ]}
                    >
                      {(group) => (
                        <Show when={group.checks.length}>
                          <details
                            open={!group.history && !group.stale}
                            classList={{ "text-text-weak": group.history }}
                            data-component={
                              group.history
                                ? "verification-history"
                                : group.unresolved
                                  ? "verification-unresolved"
                                  : group.stale
                                    ? "verification-stale"
                                    : "verification-current"
                            }
                          >
                            <summary>
                              {language.t(
                                group.history
                                  ? "session.outcome.history"
                                  : group.unresolved
                                    ? "session.outcome.unresolved"
                                    : group.stale
                                      ? "session.outcome.staleGroup"
                                      : "session.outcome.current",
                              )}
                              {" · "}
                              {group.checks.length}
                            </summary>
                            <For each={group.checks}>
                              {(check) => (
                                <details
                                  class="group/check min-w-0 break-all"
                                  classList={{
                                    "text-icon-critical-base":
                                      !group.history && (check.exit !== 0 || !!check.execution || stale(check)),
                                  }}
                                >
                                  <summary
                                    class="flex min-w-0 items-baseline gap-2 cursor-pointer"
                                    title={language.t("session.outcome.expandCheck")}
                                  >
                                    <span aria-hidden="true" class="shrink-0 group-open/check:rotate-90">
                                      ›
                                    </span>
                                    <span class="shrink-0">
                                      {stale(check)
                                        ? language.t("session.outcome.stale")
                                        : language.t(`verification.${commandVerification(check)}`)}{" "}
                                      · {check.kind}
                                    </span>
                                    <span class="min-w-0 flex-1 truncate">{check.command}</span>
                                    <span class="shrink-0">
                                      {check.execution
                                        ? language.t(`session.outcome.execution.${check.execution}`)
                                        : `exit ${check.exit}`}
                                    </span>
                                  </summary>
                                  <pre class="whitespace-pre-wrap break-all font-inherit">{check.command}</pre>
                                  <Show when={check.cwd}>
                                    <div>
                                      {language.t("session.outcome.directory")} {check.cwd}
                                    </div>
                                  </Show>
                                  <Show when={group.unresolved}>
                                    <Button
                                      size="small"
                                      variant="ghost"
                                      disabled={prompt.dirty()}
                                      title={language.t("session.outcome.prepareHint")}
                                      onClick={() => {
                                        const text = language.t("session.outcome.recheckPrompt", {
                                          command: check.command,
                                          directory: check.cwd ?? sdk().directory,
                                          targets: check.targets?.map((target) => target.path).join(", ") ?? "",
                                        })
                                        prompt.set(
                                          [{ type: "text", content: text, start: 0, end: text.length }],
                                          text.length,
                                        )
                                      }}
                                    >
                                      {language.t("session.outcome.prepareRecheck")}
                                    </Button>
                                  </Show>
                                  <Show when={check.execution}>
                                    <div>{language.t(`session.outcome.execution.${check.execution!}`)}</div>
                                  </Show>
                                  <Show when={check.supersededBy}>
                                    <div>{language.t("session.outcome.superseded")}</div>
                                  </Show>
                                  <For each={check.requirements}>
                                    {(requirement) => (
                                      <div>
                                        {language.t("session.outcome.coverage")} {requirement}
                                      </div>
                                    )}
                                  </For>
                                  <For each={check.targets}>
                                    {(target) => (
                                      <div title={target.path}>
                                        {artifactPath(target.path, sdk().directory)?.path ??
                                          target.path.split(/[\\/]/).at(-1)}
                                      </div>
                                    )}
                                  </For>
                                  <details>
                                    <summary>{language.t("session.outcome.details")}</summary>
                                    <div>{check.callID}</div>
                                    <For each={check.targets}>{(target) => <div>{target.path}</div>}</For>
                                    <For each={check.logs}>{(log) => <div>{log}</div>}</For>
                                  </details>
                                </details>
                              )}
                            </For>
                          </details>
                        </Show>
                      )}
                    </For>
                  </details>
                </Show>
              </details>
            </Show>
            <Show when={!abandoned()}>
              <Dynamic component={display.target ? Portal : "div"} mount={display.target}>
                <div class="flex flex-wrap items-center gap-1" data-component="session-recovery-actions">
                  <Show
                    when={
                      outcome()?.messageID &&
                      (outcome()?.state === "interrupted" ||
                        outcome()?.state === "failed" ||
                        outcome()?.state === "stopped")
                    }
                  >
                    <ButtonV2
                      size="small"
                      variant="outline"
                      disabled={recover.isPending}
                      onClick={() =>
                        recover.mutate({ sessionID: params.id!, messageID: outcome()!.messageID!, action: "continue" })
                      }
                    >
                      {language.t("session.outcome.continue")}
                    </ButtonV2>
                    <MenuV2>
                      <MenuV2.Trigger
                        as={ButtonV2}
                        size="small"
                        variant="ghost-muted"
                        disabled={recover.isPending}
                        aria-label={language.t("common.moreOptions")}
                      >
                        ···
                      </MenuV2.Trigger>
                      <MenuV2.Portal>
                        <MenuV2.Content>
                          <For each={["retry", "abandon"] as const}>
                            {(action) => (
                              <MenuV2.Item
                                disabled={recover.isPending}
                                onSelect={() =>
                                  recover.mutate({ sessionID: params.id!, messageID: outcome()!.messageID!, action })
                                }
                              >
                                {language.t(`session.outcome.${action}`)}
                              </MenuV2.Item>
                            )}
                          </For>
                        </MenuV2.Content>
                      </MenuV2.Portal>
                    </MenuV2>
                  </Show>
                </div>
              </Dynamic>
            </Show>
          </div>
        </Show>
      </Show>
    </>
  )
}
