import { A, action, createAsync, json, query, useAction, useParams } from "@solidjs/router"
import { Show, createSignal } from "solid-js"
import { Billing } from "@zaovra-ai/console-core/billing.js"
import { Actor } from "@zaovra-ai/console-core/actor.js"
import { and, Database, eq, isNull } from "@zaovra-ai/console-core/drizzle/index.js"
import { BillingTable, SubscriptionTable } from "@zaovra-ai/console-core/schema/billing.sql.js"
import { BlackData } from "@zaovra-ai/console-core/black.js"
import { Subscription } from "@zaovra-ai/console-core/subscription.js"
import { withActor } from "~/context/auth.withActor"
import { queryBillingInfo } from "../../common"
import styles from "./black-section.module.css"

const names = { "20": "Starter", "100": "Pro", "200": "Max" } as const

const queryMembership = query(async (workspaceID: string) => {
  "use server"
  return withActor(async () => {
    const row = await Database.use((tx) =>
      tx
        .select({
          rollingUsage: SubscriptionTable.rollingUsage,
          fixedUsage: SubscriptionTable.fixedUsage,
          timeRollingUpdated: SubscriptionTable.timeRollingUpdated,
          timeFixedUpdated: SubscriptionTable.timeFixedUpdated,
          subscription: BillingTable.subscription,
        })
        .from(BillingTable)
        .innerJoin(SubscriptionTable, eq(SubscriptionTable.workspaceID, BillingTable.workspaceID))
        .where(and(eq(SubscriptionTable.workspaceID, Actor.workspace()), isNull(SubscriptionTable.timeDeleted)))
        .then((rows) => rows[0]),
    )
    if (!row?.subscription) return null
    const limits = BlackData.getLimits({ plan: row.subscription.plan })
    return {
      plan: row.subscription.plan,
      rolling: Subscription.analyzeRollingUsage({
        limit: limits.rollingLimit,
        window: limits.rollingWindow,
        usage: row.rollingUsage ?? 0,
        timeUpdated: row.timeRollingUpdated ?? new Date(),
      }),
      fixed: Subscription.analyzeWeeklyUsage({
        limit: limits.fixedLimit,
        usage: row.fixedUsage ?? 0,
        timeUpdated: row.timeFixedUpdated ?? new Date(),
      }),
    }
  }, workspaceID)
}, "membership.get")

const createPortal = action(async (workspaceID: string, returnUrl: string) => {
  "use server"
  return json(
    await withActor(
      () => Billing.generateSessionUrl({ returnUrl }).then((data) => ({ data })).catch((error) => ({ error: error.message as string })),
      workspaceID,
    ),
    { revalidate: [queryBillingInfo.key, queryMembership.key] },
  )
}, "membership.portal")

export function BlackSection() {
  const params = useParams()
  const membership = createAsync(() => queryMembership(params.id!))
  const portal = useAction(createPortal)
  const [loading, setLoading] = createSignal(false)

  const manage = async () => {
    setLoading(true)
    const result = await portal(params.id!, window.location.href)
    if ("data" in result && result.data) {
      window.location.href = result.data
      return
    }
    setLoading(false)
  }

  return (
    <section class={styles.root}>
      <Show
        when={membership()}
        fallback={
          <div data-slot="section-title">
            <h2>Zaovra membership</h2>
            <div data-slot="title-row">
              <p>BYOK is available without a membership. Choose a plan only when you want managed model access.</p>
              <A href="/pricing" data-color="primary">View plans</A>
            </div>
          </div>
        }
      >
        {(active) => (
          <>
            <div data-slot="section-title">
              <h2>{names[active().plan]} membership</h2>
              <div data-slot="title-row">
                <p>Active managed model access · ${active().plan} per month</p>
                <button data-color="primary" disabled={loading()} onClick={manage}>
                  {loading() ? "Opening billing…" : "Manage membership"}
                </button>
              </div>
            </div>
            <div data-slot="usage">
              <div data-slot="usage-item">
                <div data-slot="usage-header"><span>Rolling usage</span><span>{active().rolling.usagePercent}%</span></div>
                <div data-slot="progress"><div data-slot="progress-bar" style={{ width: `${active().rolling.usagePercent}%` }} /></div>
              </div>
              <div data-slot="usage-item">
                <div data-slot="usage-header"><span>Plan-period usage</span><span>{active().fixed.usagePercent}%</span></div>
                <div data-slot="progress"><div data-slot="progress-bar" style={{ width: `${active().fixed.usagePercent}%` }} /></div>
              </div>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}
