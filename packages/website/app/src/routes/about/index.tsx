import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { A } from "@solidjs/router"
import lockup from "../../asset/brand-v2/lockup-white.webp"
import { SiteFooter, SiteHeader } from "~/component/site-chrome"
import { LocaleLinks } from "~/component/locale-links"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"

export default function About() {
  const i18n = useI18n()
  const language = useLanguage()
  return (
    <main data-page="about" data-skin="zaovra">
      <Title>{i18n.t("about.metaTitle")}</Title>
      <Meta name="description" content={i18n.t("about.metaDescription")} />
      <LocaleLinks path="/about" />

      <SiteHeader />

      <div data-component="about-content">
        <section data-component="about-hero">
          <div data-slot="about-copy">
            <h1>{i18n.t("about.title")}</h1>
            <p>{i18n.t("about.body")}</p>
          </div>
          <div data-slot="about-mark" aria-hidden="true">
            <img src={lockup} alt="" width="1954" height="490" />
          </div>
        </section>

        <section data-component="about-principles" aria-label={i18n.t("about.principlesLabel")}>
          <article>
            <span>{i18n.t("about.local.label")}</span>
            <h2>{i18n.t("about.local.title")}</h2>
            <p>{i18n.t("about.local.body")}</p>
          </article>
          <article>
            <span>{i18n.t("about.byok.label")}</span>
            <h2>{i18n.t("about.byok.title")}</h2>
            <p>{i18n.t("about.byok.body")}</p>
          </article>
          <article>
            <span>{i18n.t("about.review.label")}</span>
            <h2>{i18n.t("about.review.title")}</h2>
            <p>{i18n.t("about.review.body")}</p>
          </article>
        </section>

        <section data-component="about-actions">
          <div><h2>{i18n.t("about.actions.title")}</h2><p>{i18n.t("about.actions.body")}</p></div>
          <div>
            <A href={language.route("/download")} data-variant="primary">{i18n.t("about.actions.download")}</A>
            <A href={language.route("/docs")}>{i18n.t("about.actions.docs")}</A>
          </div>
        </section>
      </div>
      <SiteFooter />
    </main>
  )
}
