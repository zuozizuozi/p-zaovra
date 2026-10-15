import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { For } from "solid-js"
import { SiteFooter, SiteHeader } from "~/component/site-chrome"
import { LocaleLinks } from "~/component/locale-links"
import { useI18n } from "~/context/i18n"

const plans = [
  { id: "20", name: "Starter", summary: "pricing.starter.summary", featured: false },
  { id: "100", name: "Pro", summary: "pricing.pro.summary", featured: true },
  { id: "200", name: "Max", summary: "pricing.max.summary", featured: false },
] as const

const features = ["pricing.feature.agent", "pricing.feature.byok", "pricing.feature.managed", "pricing.feature.cancel"] as const

const notes = [
  ["pricing.note.byok.title", "pricing.note.byok.body"],
  ["pricing.note.managed.title", "pricing.note.managed.body"],
  ["pricing.note.account.title", "pricing.note.account.body"],
] as const

export default function Pricing() {
  const i18n = useI18n()
  return (
    <main data-page="pricing" data-skin="zaovra">
      <SiteHeader />
      <Title>{i18n.t("pricing.metaTitle")}</Title>
      <Meta name="description" content={i18n.t("pricing.metaDescription")} />
      <LocaleLinks path="/pricing" />

      <div data-component="pricing-shell">
        <section data-component="pricing-hero">
          <span data-slot="eyebrow">{i18n.t("pricing.eyebrow")}</span>
          <h1>{i18n.t("pricing.title")}</h1>
          <p>{i18n.t("pricing.body")}</p>
        </section>

        <aside data-component="checkout-status" role="status">
          {i18n.t("pricing.status")}
        </aside>

        <section data-component="plan-grid" aria-label={i18n.t("pricing.plansLabel")}>
          <For each={plans}>
            {(plan) => (
              <article data-component="plan-card" data-featured={plan.featured ? "" : undefined}>
                <div>
                  <span data-slot="plan-name">{plan.name}</span>
                  <p data-slot="price">
                    <strong>${plan.id}</strong>
                    <span>{i18n.t("pricing.perMonth")}</span>
                  </p>
                  <p data-slot="summary">{i18n.t(plan.summary)}</p>
                </div>
                <ul>
                  <For each={features}>{(feature) => <li>{i18n.t(feature)}</li>}</For>
                </ul>
                <button type="button" disabled>
                  {i18n.t("pricing.checkout")}
                </button>
              </article>
            )}
          </For>
        </section>

        <section data-component="pricing-notes">
          <For each={notes}>
            {(note) => (
              <div>
                <h2>{i18n.t(note[0])}</h2>
                <p>{i18n.t(note[1])}</p>
              </div>
            )}
          </For>
        </section>

      </div>
      <SiteFooter />
    </main>
  )
}
