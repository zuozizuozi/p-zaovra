import { A } from "@solidjs/router"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"

export function Footer() {
  const i18n = useI18n()
  const language = useLanguage()
  const links = [
    { href: "/pricing", label: "site.nav.pricing" },
    { href: "/download", label: "site.nav.download" },
    { href: "/docs", label: "site.nav.docs" },
    { href: "/about", label: "site.nav.about" },
    { href: "/legal/terms-of-service", label: "site.nav.terms" },
    { href: "/legal/privacy-policy", label: "site.nav.privacy" },
  ] as const

  return (
    <footer data-component="footer">
      {links.map((link) => (
        <div data-slot="cell"><A href={language.route(link.href)}>{i18n.t(link.label)}</A></div>
      ))}
    </footer>
  )
}
