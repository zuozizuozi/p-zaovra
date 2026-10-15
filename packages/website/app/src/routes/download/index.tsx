import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { A } from "@solidjs/router"
import mascot from "../../asset/mascot/thinking-512.webp"
import { SiteFooter, SiteHeader } from "~/component/site-chrome"
import { LocaleLinks } from "~/component/locale-links"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"

function WindowsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 4.5 10.5 3.4v7.8H3V4.5Zm8.7-1.3L21 1.8v9.4h-9.3v-8Zm-8.7 9h7.5V20L3 18.9v-6.7Zm8.7 0H21v10l-9.3-1.4v-8.6Z" fill="currentColor" />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <path d="M3.75 9h9.5m-3.5-3.5L13.25 9l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" />
    </svg>
  )
}

export default function Download() {
  const i18n = useI18n()
  const language = useLanguage()
  return (
    <main data-page="download" data-skin="zaovra">
      <Title>{i18n.t("download.metaTitle")}</Title>
      <Meta name="description" content={i18n.t("download.metaDescription")} />
      <LocaleLinks path="/download" />

      <SiteHeader />

      <div data-component="download-content">
        <section data-component="download-hero" aria-labelledby="download-title">
          <div data-slot="download-copy">
            <span data-slot="platform-label"><WindowsIcon /> {i18n.t("download.platform")}</span>
            <h1 id="download-title">{i18n.t("download.title")}</h1>
            <p>{i18n.t("download.body")}</p>
            <div data-slot="hero-actions">
              <button type="button" data-variant="primary" disabled>{i18n.t("download.pending")}</button>
              <A href={language.route("/pricing")}>{i18n.t("download.viewPricing")}</A>
            </div>
          </div>

          <div data-slot="download-mark" aria-hidden="true">
            <img src={mascot} alt="" width="280" height="280" />
          </div>
        </section>

        <section data-component="access-panel" aria-label={i18n.t("download.panelLabel")}>
          <article>
            <span data-slot="step-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7.5h14v9H5v-9Zm2-3v3m10-3v3M8.5 12h7" fill="none" stroke="currentColor" stroke-width="1.5" /></svg></span>
            <div>
              <span data-slot="step-label">{i18n.t("download.account.label")}</span>
              <h2>{i18n.t("download.account.title")}</h2>
              <p>{i18n.t("download.account.body")}</p>
            </div>
            <A href={language.route("/login?continue=/download")}>{i18n.t("site.nav.login")} <ArrowIcon /></A>
          </article>

          <article>
            <span data-slot="step-icon"><WindowsIcon /></span>
            <div>
              <span data-slot="step-label">{i18n.t("download.windows.label")}</span>
              <h2>{i18n.t("download.windows.title")}</h2>
              <p>{i18n.t("download.windows.body")}</p>
            </div>
            <button type="button" disabled>{i18n.t("download.windows.action")}</button>
          </article>
        </section>

      </div>
      <SiteFooter />
    </main>
  )
}
