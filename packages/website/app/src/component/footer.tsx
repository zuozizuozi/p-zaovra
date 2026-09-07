import { A } from "@solidjs/router"
import { useLanguage } from "~/context/language"

export function Footer() {
  const language = useLanguage()
  const links = [
    { href: "/pricing", label: "Pricing" },
    { href: "/download", label: "Download" },
    { href: "/about", label: "About us" },
    { href: "/legal/terms-of-service", label: "Terms" },
    { href: "/legal/privacy-policy", label: "Privacy" },
  ]

  return (
    <footer data-component="footer">
      {links.map((link) => (
        <div data-slot="cell"><A href={language.route(link.href)}>{link.label}</A></div>
      ))}
    </footer>
  )
}
