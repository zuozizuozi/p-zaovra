import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { A } from "@solidjs/router"
import { For, Show } from "solid-js"
import { SiteFooter, SiteHeader } from "~/component/site-chrome"
import { LocaleLinks } from "~/component/locale-links"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"

const start = [
  ["docs.start.title", "docs.start.body"],
  ["docs.workspace.title", "docs.workspace.body"],
  ["docs.review.title", "docs.review.body"],
] as const

const providerSteps = ["docs.providers.step1", "docs.providers.step2", "docs.providers.step3", "docs.providers.step4"] as const
const customSteps = ["docs.custom.step1", "docs.custom.step2", "docs.custom.step3", "docs.custom.step4"] as const
const builtin = ["Anthropic", "OpenAI", "Google", "GitHub Copilot", "OpenRouter", "Vercel AI Gateway"]

export function DocsPage(props: { moved?: boolean }) {
  const i18n = useI18n()
  const language = useLanguage()

  return (
    <main data-page="docs" data-skin="zaovra">
      <Title>{i18n.t("docs.metaTitle")}</Title>
      <Meta name="description" content={i18n.t("docs.metaDescription")} />
      <LocaleLinks path="/docs" />

      <SiteHeader />

      <div data-component="docs-layout">
        <aside data-component="docs-toc" aria-label={i18n.t("docs.toc")}>
          <span>{i18n.t("docs.toc")}</span>
          <a href="#start">{i18n.t("docs.title")}</a>
          <a href="#providers">{i18n.t("docs.providers.title")}</a>
          <a href="#custom">{i18n.t("docs.custom.title")}</a>
          <a href="#billing">{i18n.t("docs.billing.title")}</a>
          <a href="#help">{i18n.t("docs.help.title")}</a>
        </aside>

        <article data-component="docs-body">
          <Show when={props.moved}>
            <p data-slot="moved" role="status">
              {i18n.t("docs.notFound")}
            </p>
          </Show>

          <section id="start">
            <span data-slot="eyebrow">{i18n.t("docs.eyebrow")}</span>
            <h1>{i18n.t("docs.title")}</h1>
            <p data-slot="lead">{i18n.t("docs.body")}</p>
            <For each={start}>
              {(item) => (
                <div data-slot="step">
                  <h3>{i18n.t(item[0])}</h3>
                  <p>{i18n.t(item[1])}</p>
                </div>
              )}
            </For>
            <A href={language.route("/download")} data-slot="text-link">
              {i18n.t("docs.start.link")} →
            </A>
          </section>

          <section id="providers">
            <h2>{i18n.t("docs.providers.title")}</h2>
            <p>{i18n.t("docs.providers.body")}</p>
            <h3>{i18n.t("docs.providers.steps.title")}</h3>
            <ol>
              <For each={providerSteps}>{(step) => <li>{i18n.t(step)}</li>}</For>
            </ol>
            <ul data-slot="chips" aria-label={i18n.t("docs.providers.builtinLabel")}>
              <For each={builtin}>{(name) => <li>{name}</li>}</For>
            </ul>
          </section>

          <section id="custom">
            <h2>{i18n.t("docs.custom.title")}</h2>
            <p>{i18n.t("docs.custom.body")}</p>
            <ol>
              <For each={customSteps}>{(step) => <li>{i18n.t(step)}</li>}</For>
            </ol>
          </section>

          <section id="billing">
            <h2>{i18n.t("docs.billing.title")}</h2>
            <p>{i18n.t("docs.billing.body")}</p>
          </section>

          <section id="help">
            <h2>{i18n.t("docs.help.title")}</h2>
            <p>{i18n.t("docs.help.body")}</p>
            <a href="mailto:support@zaovra.com" data-slot="text-link">
              support@zaovra.com →
            </a>
          </section>
        </article>
      </div>
      <SiteFooter />
    </main>
  )
}

export default function Docs() {
  return <DocsPage />
}
