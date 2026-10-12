import { For, Show, createMemo } from "solid-js"
import { useParams } from "@solidjs/router"
import { createQuery, useMutation } from "@tanstack/solid-query"
import { Button } from "@zaovra-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { hasUnfinishedShell } from "@/context/v2-session-adapter"
import { showToast } from "@/utils/toast"
import { commandVerification, staleVerification } from "@/utils/verification-label"
import { artifactPath } from "@/utils/artifact-path"

export function SessionOutcomeDock() {
  const params = useParams()
  const sdk = useSDK()
  const server = useServerSDK()
  const sync = useServerSync()
  const language = useLanguage()
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
  const failedChecks = createMemo(() => currentChecks().filter((check) => check.exit !== 0 && !check.execution).length)
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
  return (
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
          <span>{language.t(abandoned() ? "session.outcome.abandoned" : `session.outcome.${outcome()!.state}`)}</span>
          <Show when={outcome()?.outcomeUnknown && !abandoned()}>
            <span role="alert" class="text-icon-critical-base font-medium">
              {language.t("session.outcome.unknown")}
            </span>
          </Show>
          <div class="font-medium" data-component="verification-summary">
            {language.t("session.outcome.checks")} ·{" "}
            <Show when={currentChecks().length} fallback={language.t("session.outcome.noChecks")}>
              {language.t("session.outcome.passedCount", { count: passedChecks() })}
              <Show when={staleChecks()}>
                <span class="text-icon-critical-base">
                  {" · "}
                  {language.t("session.outcome.staleCount", { count: staleChecks() })}
                </span>
              </Show>
              <Show when={failedChecks()}>
                <span class="text-icon-critical-base">
                  {" · "}
                  {language.t("session.outcome.failedCount", { count: failedChecks() })}
                </span>
              </Show>
              <Show when={incompleteChecks()}>
                <span class="text-icon-critical-base">
                  {" · "}
                  {language.t("session.outcome.incompleteCount", { count: incompleteChecks() })}
                </span>
              </Show>
            </Show>
          </div>
          <Show when={staleChecks()}>
            <span>{language.t("session.outcome.staleHint")}</span>
          </Show>
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
            <For
              each={[
                { history: false, checks: currentChecks() },
                { history: true, checks: historicalChecks() },
              ]}
            >
              {(group) => (
                <Show when={group.checks.length}>
                  <details
                    open={!group.history}
                    classList={{ "text-text-weak": group.history }}
                    data-component={group.history ? "verification-history" : "verification-current"}
                  >
                    <summary>
                      {language.t(group.history ? "session.outcome.history" : "session.outcome.current")}
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
                                {artifactPath(target.path, sdk().directory)?.path ?? target.path.split(/[\\/]/).at(-1)}
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
            <Show when={outcome()?.missing.length}>
              <details role="alert" class="text-icon-critical-base font-medium">
                <summary>
                  {language.t("session.outcome.missing")} · {outcome()?.missing.length}
                </summary>
                {language.t("session.outcome.missing")}{" "}
                {outcome()
                  ?.missing.map((item) => (item === "requirements" ? language.t("session.outcome.requirements") : item))
                  .join(", ")}
              </details>
            </Show>
          </Show>
          <Show when={!abandoned()}>
            <div class="flex flex-wrap gap-1">
              <Show
                when={outcome()?.messageID && (outcome()?.state === "interrupted" || outcome()?.state === "failed")}
              >
                <For each={["continue", "retry", "abandon"] as const}>
                  {(action) => (
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={recover.isPending}
                      onClick={() =>
                        recover.mutate({ sessionID: params.id!, messageID: outcome()!.messageID!, action })
                      }
                    >
                      {language.t(`session.outcome.${action}`)}
                    </Button>
                  )}
                </For>
              </Show>
              <Button
                size="small"
                variant="ghost"
                disabled={query.isFetching || recover.isPending}
                onClick={() => void query.refetch()}
              >
                {language.t("session.outcome.refresh")}
              </Button>
            </div>
          </Show>
        </div>
      </Show>
    </Show>
  )
}
