import { For, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { createQuery, useMutation } from "@tanstack/solid-query"
import { Button } from "@zaovra-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { hasUnfinishedShell } from "@/context/v2-session-adapter"
import { showToast } from "@/utils/toast"

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
          query.data &&
          query.data.state !== "idle" &&
          query.data.state !== "running" &&
          !sync().session.data.session_working(params.id ?? "")
        }
      >
        <div
          class="px-1 py-2 flex flex-col gap-1 text-12-regular text-text-weak"
          role="status"
          aria-busy={recover.isPending}
        >
          <span>{language.t(abandoned() ? "session.outcome.abandoned" : `session.outcome.${query.data!.state}`)}</span>
          <Show when={query.data?.outcomeUnknown && !abandoned()}>
            <span>{language.t("session.outcome.unknown")}</span>
          </Show>
          <Show when={query.data?.checks.length || query.data?.missing.length}>
            <details>
              <summary>{language.t("session.outcome.checks")}</summary>
              <For each={query.data?.checks}>
                {(check) => (
                  <div class="break-all">
                    {check.kind}: {check.command} · exit {check.exit}
                    <For each={check.targets}>{(target) => <div>{target.path}</div>}</For>
                    <For each={check.logs}>{(log) => <div>{log}</div>}</For>
                  </div>
                )}
              </For>
              <Show when={query.data?.missing.length}>
                <div>
                  {language.t("session.outcome.missing")} {query.data?.missing.join(", ")}
                </div>
              </Show>
            </details>
          </Show>
          <Show when={!abandoned()}>
            <div class="flex flex-wrap gap-1">
              <Show
                when={query.data?.messageID && (query.data.state === "interrupted" || query.data.state === "failed")}
              >
                <For each={["continue", "retry", "abandon"] as const}>
                  {(action) => (
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={recover.isPending}
                      onClick={() =>
                        recover.mutate({ sessionID: params.id!, messageID: query.data!.messageID!, action })
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
