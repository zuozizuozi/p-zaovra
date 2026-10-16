import "./site-chrome.css"
import { A } from "@solidjs/router"
import wordmark from "../asset/brand-v2/wordmark-white.webp"
import idle from "../asset/mascot/idle-128.webp"
import { LanguagePicker } from "~/component/language-picker"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"

function Brand() {
  return (
    <>
      <img src={idle} alt="" width="32" height="32" />
      <img data-slot="wordmark" src={wordmark} alt="" width="1405" height="204" />
    </>
  )
}

export function SiteHeader() {
  const i18n = useI18n()
  const language = useLanguage()
  const links = [
    { href: `${language.route("/")}#product`, label: i18n.t("home.v3.nav.product") },
    { href: language.route("/pricing"), label: i18n.t("site.nav.pricing") },
    { href: language.route("/docs"), label: i18n.t("site.nav.docs") },
    { href: language.route("/about"), label: i18n.t("site.nav.about") },
  ]

  return (
    <header data-component="site-header">
      <div data-slot="inner">
        <A href={language.route("/")} data-slot="brand" aria-label={i18n.t("site.nav.home")}>
          <Brand />
        </A>
        <nav data-slot="nav" aria-label={i18n.t("site.nav.ariaLabel")}>
          {links.map((link) => (
            <A href={link.href}>{link.label}</A>
          ))}
        </nav>
        <div data-slot="actions">
          <A href={language.route("/login")} data-variant="ghost">
            {i18n.t("site.nav.login")}
          </A>
          <A href={language.route("/download")} data-variant="solid">
            {i18n.t("site.nav.download")}
          </A>
        </div>
        <details data-slot="mobile-nav">
          <summary aria-label={i18n.t("site.nav.menu")}>
            <i />
            <i />
          </summary>
          <nav aria-label={i18n.t("site.nav.ariaLabel")}>
            {links.map((link) => (
              <A href={link.href}>{link.label}</A>
            ))}
            <A href={language.route("/download")}>{i18n.t("site.nav.download")}</A>
            <A href={language.route("/login")}>{i18n.t("site.nav.login")}</A>
          </nav>
        </details>
      </div>
    </header>
  )
}

export function SiteFooter() {
  const i18n = useI18n()
  const language = useLanguage()

  return (
    <footer data-component="site-footer">
      <div data-slot="brand">
        <A href={language.route("/")} aria-label={i18n.t("site.nav.home")}>
          <Brand />
        </A>
        <p>{i18n.t("home.v3.footer.tagline")}</p>
      </div>
      <nav aria-label={i18n.t("home.v3.footer.product")}>
        <strong>{i18n.t("home.v3.footer.product")}</strong>
        <A href={language.route("/download")}>{i18n.t("site.nav.download")}</A>
        <A href={language.route("/pricing")}>{i18n.t("site.nav.pricing")}</A>
        <A href={language.route("/docs")}>{i18n.t("site.nav.docs")}</A>
        <A href={language.route("/changelog")}>{i18n.t("nav.changelog")}</A>
      </nav>
      <nav aria-label={i18n.t("home.v3.footer.company")}>
        <strong>{i18n.t("home.v3.footer.company")}</strong>
        <A href={language.route("/about")}>{i18n.t("site.nav.about")}</A>
        <A href={language.route("/legal/terms-of-service")}>{i18n.t("site.nav.terms")}</A>
        <A href={language.route("/legal/privacy-policy")}>{i18n.t("site.nav.privacy")}</A>
      </nav>
      <nav aria-label={i18n.t("home.v3.footer.contact")}>
        <strong>{i18n.t("home.v3.footer.contact")}</strong>
        <a href="mailto:support@zaovra.com">support@zaovra.com</a>
        <LanguagePicker />
      </nav>
      <small>©{new Date().getFullYear()} Zaovra</small>
    </footer>
  )
}
