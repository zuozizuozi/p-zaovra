import { createEffect, createResource, For, onCleanup, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useSettingsDialog } from "./settings-dialog"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import type { V2SessionUsageResponses } from "@zaovra-ai/sdk/v2/client"
import { usageDisplay } from "@/utils/usage-display"
import "./usage-dashboard.css"

type Summary = V2SessionUsageResponses[200]["data"]
type Totals = Summary["total"]
const tokenLabel = (totals: Totals) => `${totals.unreported ? "≥ " : ""}${totals.total.toLocaleString()}`

function useUsage(sessionID: () => string | undefined, enabled: () => boolean = () => true) {
  const sdk = useServerSDK()
  const sync = useServerSync()
  const [usage, { refetch }] = createResource(
    () =>
      enabled() && {
        sdk: sdk(),
        sessionID: sessionID(),
        prices: JSON.stringify(
          Object.entries(sync().data.config.provider ?? {}).map(([id, provider]) => [
            id,
            Object.entries(provider.models ?? {}).map(([id, model]) => [id, model.cost]),
          ]),
        ),
      },
    async (input) => {
      const response = await input.sdk.client.v2.session.usage({ sessionID: input.sessionID }, { throwOnError: true })
      if (!response.data?.data) throw new Error("Usage response is missing")
      return response.data.data
    },
  )
  createEffect(() => {
    const server = sdk()
    const sessions = sync().session
    const pending = new Set<string>()
    let disposed = false
    const refresh = () => {
      if (!disposed && enabled()) void refetch()
    }
    const unsubscribe = server.event.listen((event) => {
      const value = event.details
      if (value.type === "session.status" && value.properties.status.type === "idle") {
        if (!sessionID() || value.properties.sessionID === sessionID()) refresh()
        return
      }
      if (
        value.type !== "session.next.step.ended" &&
        value.type !== "session.next.step.failed" &&
        value.type !== "session.next.compaction.ended" &&
        value.type !== "session.next.compaction.failed"
      )
        return
      if (sessionID() && value.properties.sessionID !== sessionID()) return
      // Usage settlements are durable before this event; expose them during long tasks too.
      refresh()
      if (pending.has(value.properties.sessionID)) return
      pending.add(value.properties.sessionID)
      // Share the existing execution watcher: tool continuations are one user turn.
      const settled = () => {
        pending.delete(value.properties.sessionID)
        refresh()
      }
      void sessions.watchExecution(value.properties.sessionID).then(settled, settled)
    })
    // Reconcile after a missed finish event while the desktop was asleep/offline.
    window.addEventListener("focus", refresh)
    onCleanup(() => {
      disposed = true
      unsubscribe()
      window.removeEventListener("focus", refresh)
    })
  })
  return { usage, refetch }
}

export function SessionUsageBar() {
  const params = useParams<{ id?: string }>()
  const language = useLanguage()
  const open = useSettingsDialog("usage")
  const { usage } = useUsage(
    () => params.id,
    () => !!params.id,
  )
  const value = () => (!params.id || usage.loading || usage.error ? undefined : usage())
  return (
    <details class="session-usage-details">
      <summary class="session-usage-bar" title={language.t("usage.sessionScope")}>
        <span>{language.t("usage.details")}</span>
        <Show when={!usage.error} fallback={<span>{language.t("usage.error")}</span>}>
          <span>
            {language.t("usage.conversation")}{" "}
            <b>
              {value()
                ? usageDisplay(value()!.total).unknown
                  ? language.t("usage.unknown")
                  : tokenLabel(value()!.total)
                : params.id
                  ? "—"
                  : "0"}
            </b>{" "}
            Tokens
          </span>
          <span>
            {language.t("usage.lastTurn")}{" "}
            <b>
              {value()?.lastTurn
                ? usageDisplay(value()!.lastTurn!).unknown
                  ? language.t("usage.unknown")
                  : tokenLabel(value()!.lastTurn!)
                : "—"}
            </b>
          </span>
          <Show when={value()?.total.unreported}>
            <span>{language.t("usage.incomplete")}</span>
          </Show>
        </Show>
      </summary>
      <Show when={value()}>
        {(data) => (
          <>
            <UsageCard label={language.t("usage.conversation")} totals={data().total} />
            <UsageEstimates models={data().models ?? []} />
          </>
        )}
      </Show>
      <button type="button" class="text-12-regular underline p-2" onClick={open}>
        {language.t("usage.title")}
      </button>
    </details>
  )
}

export function UsageDashboard() {
  const language = useLanguage()
  const sync = useServerSync()
  const sdk = useServerSDK()
  const { usage, refetch } = useUsage(() => undefined)
  const value = () => (usage.loading || usage.error ? undefined : usage())
  const [recent] = createResource(
    () => ({
      sdk: sdk(),
      updatedAt: value()?.updatedAt,
      sessions: Object.values(sync().session.data.info)
        .filter((item) => !!item)
        .sort((a, b) => b.time.updated - a.time.updated)
        .slice(0, 5),
    }),
    (input) =>
      Promise.all(
        input.sessions.map(async (session) => ({
          title: session.title,
          usage: await input.sdk.client.v2.session
            .usage({ sessionID: session.id }, { throwOnError: true })
            .then((result) => result.data.data.total)
            .catch(() => undefined),
        })),
      ),
  )
  return (
    <section class="usage-dashboard" aria-label={language.t("usage.title")}>
      <div class="usage-dashboard-heading">
        <h2>{language.t("usage.title")}</h2>
        <ButtonV2 variant="outline" size="small" disabled={usage.loading} onClick={() => void refetch()}>
          {language.t("usage.refresh")}
        </ButtonV2>
      </div>
      <p>{language.t("usage.scope")}</p>
      <Show when={usage.error}>
        <div role="alert">{language.t("usage.error")}</div>
      </Show>
      <Show when={value()} fallback={<p>{usage.loading ? language.t("usage.loading") : "—"}</p>}>
        {(data) => (
          <>
            <div class="usage-billing">
              <div>
                <span>{language.t("usage.ownBalance")}</span>
                <strong>{language.t("usage.providerManaged")}</strong>
              </div>
              <div>
                <span>{language.t("usage.planSpent")}</span>
                <strong>{language.t("usage.billingUnavailable")}</strong>
              </div>
              <div>
                <span>{language.t("usage.remaining")}</span>
                <strong>{language.t("usage.billingUnavailable")}</strong>
              </div>
            </div>
            <div class="usage-card-grid">
              <UsageCard label={language.t("model.source.own")} totals={data().own} />
              <UsageCard label={language.t("model.source.official")} totals={data().official} />
            </div>
            <Show when={data().unknown.calls > 0}>
              <UsageCard label={language.t("usage.unknownSource")} totals={data().unknown} />
            </Show>
            <p>{language.t("usage.billingNote")}</p>
            <UsageEstimates models={data().models ?? []} />
            <Show when={recent()?.length}>
              <h3>{language.t("usage.recent")}</h3>
              <For each={recent()}>
                {(item) => (
                  <div class="usage-billing">
                    <span>{item.title}</span>
                    <strong>
                      {item.usage
                        ? usageDisplay(item.usage).unknown
                          ? language.t("usage.unknown")
                          : tokenLabel(item.usage)
                        : language.t("usage.error")}
                    </strong>
                  </div>
                )}
              </For>
            </Show>
            <p class="usage-updated">
              {language.t("usage.updated")} {new Date(data().updatedAt).toLocaleString()}
            </p>
          </>
        )}
      </Show>
    </section>
  )
}

function UsageCard(props: { label: string; totals: Totals }) {
  const language = useLanguage()
  const fields = ["input", "cacheRead", "cacheWrite", "outputIncludingReasoning", "reasoning", "calls"] as const
  return (
    <section class="usage-card" aria-label={props.label}>
      <h3>{props.label}</h3>
      <div class="usage-total">
        {usageDisplay(props.totals).unknown ? language.t("usage.unknown") : tokenLabel(props.totals)}{" "}
        <span>Tokens</span>
      </div>
      <dl>
        <For each={fields}>
          {(key) => (
            <div>
              <dt>{language.t(`usage.${key}`)}</dt>
              <dd>
                {key !== "calls" && usageDisplay(props.totals).unknown
                  ? language.t("usage.unknown")
                  : `${props.totals.unreported && key !== "calls" ? "≥ " : ""}${(key === "outputIncludingReasoning" ? usageDisplay(props.totals).output : props.totals[key]).toLocaleString()}`}
              </dd>
            </div>
          )}
        </For>
        <div>
          <dt>{language.t("usage.hitRate")}</dt>
          <dd>
            {usageDisplay(props.totals).hitRate === undefined
              ? language.t("usage.unknown")
              : `${(usageDisplay(props.totals).hitRate! * 100).toFixed(1)}%`}
          </dd>
        </div>
      </dl>
      <p>{language.t("usage.hitRateHint")}</p>
      <Show when={props.totals.unreported > 0}>
        <p>
          {language.t("usage.incomplete")} · {props.totals.unreported} {language.t("usage.unreported")}
        </p>
      </Show>
    </section>
  )
}

function UsageEstimates(props: { models: Summary["models"] }) {
  const language = useLanguage()
  return (
    <section class="usage-card" aria-label={language.t("usage.estimate")}>
      <h3>{language.t("usage.estimate")}</h3>
      <p>{language.t("usage.estimateNote")}</p>
      <Show when={props.models.length} fallback={<p>{language.t("usage.unknown")}</p>}>
        <For each={props.models}>
          {(model) => (
            <div class="usage-billing flex flex-wrap justify-between gap-2">
              <span class="break-all">
                {model.providerID ?? language.t("usage.unknown")} / {model.modelID ?? language.t("usage.unknown")}
              </span>
              <strong>
                {!model.modelID
                  ? language.t("usage.unknown")
                  : !model.priceConfigured
                    ? language.t("usage.noPrice")
                    : model.estimate === null
                      ? language.t("usage.incomplete")
                      : `USD ${model.estimate.toFixed(6)}`}
              </strong>
              <Show when={model.estimate === null}>
                <div class="w-full text-12-regular">
                  <Show when={model.pricedAmount !== undefined}>
                    <p>
                      {language.t("usage.pricedPart")}: USD {model.pricedAmount.toFixed(6)}
                    </p>
                  </Show>
                  <Show when={model.modelUnavailable || !model.modelID}>
                    <p>{language.t("usage.modelUnavailable")}</p>
                  </Show>
                  <For each={["input", "output", "cacheRead", "cacheWrite"] as const}>
                    {(key) => (
                      <Show when={model.unpriced?.[key]}>
                        <p>
                          {language.t("usage.missingPrice", {
                            field: language.t(key === "output" ? "usage.outputIncludingReasoning" : `usage.${key}`),
                            count: model.unpriced[key].toLocaleString(),
                          })}
                        </p>
                      </Show>
                    )}
                  </For>
                  <Show when={model.tokens.unreported}>
                    <p>{language.t("usage.unreportedReason", { count: model.tokens.unreported })}</p>
                  </Show>
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </section>
  )
}
