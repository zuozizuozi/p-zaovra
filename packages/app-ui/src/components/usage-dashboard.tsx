import { createEffect, createResource, For, onCleanup, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useSettingsDialog } from "./settings-dialog"
import { ButtonV2 } from "@zaovra-ai/ui/v2/button-v2"
import type { V2SessionUsageResponses } from "@zaovra-ai/sdk/v2/client"
import "./usage-dashboard.css"

type Summary = V2SessionUsageResponses[200]["data"]
type Totals = Summary["total"]
const tokenLabel = (totals: Totals) => `${totals.unreported ? "≥ " : ""}${totals.total.toLocaleString()}`

function useUsage(sessionID: () => string | undefined, enabled: () => boolean = () => true) {
  const sdk = useServerSDK()
  const sync = useServerSync()
  const [usage, { refetch }] = createResource(
    () => enabled() && { sdk: sdk(), sessionID: sessionID() },
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
    <button
      type="button"
      class="session-usage-bar"
      onClick={open}
      aria-label={language.t("usage.title")}
      title={language.t("usage.sessionScope")}
    >
      <span>{language.t("usage.title")}</span>
      <Show when={!usage.error} fallback={<span>{language.t("usage.error")}</span>}>
        <span>
          {language.t("usage.conversation")} <b>{value() ? tokenLabel(value()!.total) : params.id ? "—" : "0"}</b>{" "}
          Tokens
        </span>
        <span>
          {language.t("usage.lastTurn")} <b>{value()?.lastTurn ? tokenLabel(value()!.lastTurn!) : "—"}</b>
        </span>
        <Show when={value()?.total.unreported}>
          <span>{language.t("usage.incomplete")}</span>
        </Show>
      </Show>
    </button>
  )
}

export function UsageDashboard() {
  const language = useLanguage()
  const { usage, refetch } = useUsage(() => undefined)
  const value = () => (usage.loading || usage.error ? undefined : usage())
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
  const fields = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "calls"] as const
  return (
    <section class="usage-card" aria-label={props.label}>
      <h3>{props.label}</h3>
      <div class="usage-total">
        {tokenLabel(props.totals)} <span>Tokens</span>
      </div>
      <dl>
        <For each={fields}>
          {(key) => (
            <div>
              <dt>{language.t(`usage.${key}`)}</dt>
              <dd>{props.totals[key].toLocaleString()}</dd>
            </div>
          )}
        </For>
      </dl>
      <Show when={props.totals.unreported > 0}>
        <p>
          {language.t("usage.incomplete")} · {props.totals.unreported} {language.t("usage.unreported")}
        </p>
      </Show>
    </section>
  )
}
