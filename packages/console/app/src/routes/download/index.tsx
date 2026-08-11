import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { A } from "@solidjs/router"
import logo from "../../asset/logo-ornate-dark.svg"
import logoSquare from "../../asset/brand/zaovra-logo-light-square.png"
import { LocaleLinks } from "~/component/locale-links"
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
  const language = useLanguage()
  return (
    <main data-page="download">
      <Title>Download Zaovra for Windows</Title>
      <Meta name="description" content="Choose Zaovra access and get the Windows desktop app when the release is available." />
      <LocaleLinks path="/download" />

      <header data-component="download-header">
        <A href={language.route("/")} aria-label="Zaovra home">
          <img src={logo} alt="Zaovra" width="140" height="32" />
        </A>
        <nav aria-label="Download page navigation">
          <A href={language.route("/go")}>Pricing</A>
          <A href={language.route("/#byok")}>BYOK</A>
          <A href={language.route("/about")}>About us</A>
          <A href={language.route("/login?continue=/download")} data-slot="login-link">Log in</A>
        </nav>
      </header>

      <div data-component="download-content">
        <section data-component="download-hero" aria-labelledby="download-title">
          <div data-slot="download-copy">
            <span data-slot="platform-label"><WindowsIcon /> Windows desktop</span>
            <h1 id="download-title">Bring Zaovra to the code you are working on.</h1>
            <p>
              Choose your access, then return here for the Windows desktop release. Purchases and downloads stay on this site;
              provider credentials are configured only inside the desktop app.
            </p>
            <div data-slot="hero-actions">
              <A href={language.route("/go")} data-variant="primary">View pricing <ArrowIcon /></A>
              <A href={language.route("/login?continue=/download")}>Log in</A>
            </div>
          </div>

          <div data-slot="download-mark" aria-hidden="true">
            <span data-slot="mark-shell"><span><img src={logoSquare} alt="" /></span></span>
            <i data-position="one" /><i data-position="two" /><i data-position="three" />
          </div>
        </section>

        <section data-component="access-panel" aria-label="Purchase and download status">
          <article>
            <span data-slot="step-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7.5h14v9H5v-9Zm2-3v3m10-3v3M8.5 12h7" fill="none" stroke="currentColor" stroke-width="1.5" /></svg></span>
            <div>
              <span data-slot="step-label">Choose access</span>
              <h2>Purchase Zaovra Go</h2>
              <p>Review the current plan and continue through the existing secure checkout flow.</p>
            </div>
            <A href={language.route("/go")}>Pricing <ArrowIcon /></A>
          </article>

          <article>
            <span data-slot="step-icon"><WindowsIcon /></span>
            <div>
              <span data-slot="step-label">Windows x64</span>
              <h2>Desktop release</h2>
              <p>The download action will be enabled after the Windows release asset is available.</p>
            </div>
            <button type="button" disabled>Release pending</button>
          </article>
        </section>

        <footer data-component="download-footer">
          <span>Zaovra for Windows</span>
          <div>
            <A href={language.route("/legal/terms-of-service")}>Terms</A>
            <A href={language.route("/legal/privacy-policy")}>Privacy</A>
            <A href={language.route("/")}>Home</A>
          </div>
        </footer>
      </div>
    </main>
  )
}
