import logoLight from "../asset/logo-ornate-light.svg"
import logoDark from "../asset/logo-ornate-dark.svg"
import { A } from "@solidjs/router"
import { Match, Show, Switch, createSignal } from "solid-js"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"

export function Header(_props: { hideGetStarted?: boolean }) {
  const i18n = useI18n()
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const links = [
    { href: "/pricing", label: "Pricing" },
    { href: "/#byok", label: "BYOK" },
    { href: "/download", label: "Download" },
    { href: "/about", label: "About us" },
  ]

  return (
    <section data-component="top">
      <A href={language.route("/")} aria-label="Zaovra home">
        <img data-slot="logo light" src={logoLight} alt={i18n.t("nav.logoAlt")} width="189" height="34" />
        <img data-slot="logo dark" src={logoDark} alt={i18n.t("nav.logoAlt")} width="189" height="34" />
      </A>

      <nav data-component="nav-desktop" aria-label="Primary navigation">
        <ul>
          {links.map((link) => <li><A href={language.route(link.href)}>{link.label}</A></li>)}
          <li><A href={language.route("/login")} data-slot="login">Log in</A></li>
        </ul>
      </nav>

      <nav data-component="nav-mobile">
        <button
          type="button"
          data-component="nav-mobile-toggle"
          aria-expanded={open()}
          aria-controls="nav-mobile-menu"
          onClick={() => setOpen(!open())}
        >
          <span class="sr-only">{i18n.t("nav.openMenu")}</span>
          <Switch>
            <Match when={open()}><span aria-hidden="true">×</span></Match>
            <Match when={!open()}><span aria-hidden="true">☰</span></Match>
          </Switch>
        </button>
        <Show when={open()}>
          <div id="nav-mobile-menu">
            {links.map((link) => <A href={language.route(link.href)} onClick={() => setOpen(false)}>{link.label}</A>)}
            <A href={language.route("/login")} onClick={() => setOpen(false)}>Log in</A>
          </div>
        </Show>
      </nav>
    </section>
  )
}
