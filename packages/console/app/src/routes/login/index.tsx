import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { A, useSearchParams } from "@solidjs/router"
import { createMemo, type JSX } from "solid-js"
import logo from "../../asset/logo-ornate-dark.svg"
import logoSquare from "../../asset/brand/zaovra-logo-light-square.png"
import { LocaleLinks } from "~/component/locale-links"
import { useLanguage } from "~/context/language"

function GitHubIcon(props: JSX.SvgSVGAttributes<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill="currentColor"
        d="M12 2.5a9.72 9.72 0 0 0-3.07 18.94c.49.09.67-.21.67-.47v-1.7c-2.73.59-3.3-1.16-3.3-1.16-.45-1.14-1.09-1.44-1.09-1.44-.89-.61.07-.6.07-.6.98.07 1.5 1.01 1.5 1.01.88 1.5 2.3 1.07 2.86.82.09-.63.34-1.07.62-1.32-2.18-.25-4.47-1.09-4.47-4.82 0-1.07.38-1.94 1-2.62-.1-.25-.43-1.25.1-2.59 0 0 .82-.26 2.67 1a9.25 9.25 0 0 1 4.86 0c1.85-1.26 2.66-1 2.66-1 .54 1.34.2 2.34.1 2.59.63.68 1 1.55 1 2.62 0 3.74-2.3 4.57-4.48 4.81.35.3.66.9.66 1.82v2.59c0 .26.18.57.67.47A9.72 9.72 0 0 0 12 2.5Z"
      />
    </svg>
  )
}

function GoogleIcon(props: JSX.SvgSVGAttributes<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path fill="#4285f4" d="M21.35 12.22c0-.7-.06-1.37-.18-2.02H12v3.82h5.24a4.48 4.48 0 0 1-1.94 2.94v2.48h3.14c1.84-1.7 2.9-4.2 2.9-7.22Z" />
      <path fill="#34a853" d="M12 21.75c2.62 0 4.82-.87 6.44-2.31l-3.14-2.48c-.87.58-1.98.93-3.3.93-2.53 0-4.67-1.71-5.44-4.01H3.32v2.56A9.73 9.73 0 0 0 12 21.75Z" />
      <path fill="#fbbc05" d="M6.56 13.88A5.85 5.85 0 0 1 6.25 12c0-.65.11-1.29.31-1.88V7.56H3.32A9.73 9.73 0 0 0 2.25 12c0 1.6.38 3.11 1.07 4.44l3.24-2.56Z" />
      <path fill="#ea4335" d="M12 6.11c1.43 0 2.7.49 3.71 1.45l2.79-2.79A9.34 9.34 0 0 0 12 2.25a9.73 9.73 0 0 0-8.68 5.31l3.24 2.56c.77-2.3 2.91-4.01 5.44-4.01Z" />
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

export default function Login() {
  const language = useLanguage()
  const [search] = useSearchParams()
  const continuePath = createMemo(() => {
    const value = search.continue
    if (typeof value !== "string" || !value.startsWith("/")) return undefined
    return value
  })
  const authorizeHref = (provider: "github" | "google") => {
    const params = new URLSearchParams({ provider })
    if (continuePath()) params.set("continue", continuePath()!)
    return `/auth/authorize?${params}`
  }

  return (
    <main data-page="login">
      <Title>Log in · Zaovra</Title>
      <Meta name="description" content="Sign in to your Zaovra account with GitHub or Google." />
      <LocaleLinks path="/login" />

      <header data-component="login-header">
        <A href={language.route("/")} aria-label="Zaovra home">
          <img src={logo} alt="Zaovra" width="140" height="32" />
        </A>
        <A href={language.route("/")} data-slot="back-link">
          Back to home
        </A>
      </header>

      <section data-component="login-stage" aria-labelledby="login-title">
        <div data-slot="stage-glow" aria-hidden="true" />
        <div data-slot="stage-particles" aria-hidden="true">
          <i /><i /><i /><i /><i /><i /><i /><i />
        </div>

        <div data-component="login-side-card" data-side="left" aria-hidden="true">
          <div data-slot="side-mark"><GitHubIcon /></div>
          <strong>GitHub identity</strong>
          <span>Continue with a verified primary email.</span>
          <div data-slot="ghost-action" />
        </div>

        <div data-component="login-side-card" data-side="right" aria-hidden="true">
          <div data-slot="side-mark"><GoogleIcon /></div>
          <strong>Google identity</strong>
          <span>Continue with a verified Google account.</span>
          <div data-slot="ghost-action" />
        </div>

        <div data-component="login-card">
          <span data-slot="card-pin" data-position="top-left" aria-hidden="true" />
          <span data-slot="card-pin" data-position="top-right" aria-hidden="true" />
          <span data-slot="card-pin" data-position="bottom-left" aria-hidden="true" />
          <span data-slot="card-pin" data-position="bottom-right" aria-hidden="true" />

          <div data-slot="brand-chip">
            <span data-slot="brand-chip-inner">
              <img src={logoSquare} alt="" aria-hidden="true" />
            </span>
          </div>
          <h1 id="login-title">Sign in to Zaovra</h1>
          <p data-slot="login-intro">Choose the account provider you already use.</p>

          <div data-slot="provider-list">
            <a href={authorizeHref("github")} data-provider="github">
              <GitHubIcon />
              <span>Continue with GitHub</span>
              <ArrowIcon />
            </a>
            <a href={authorizeHref("google")} data-provider="google">
              <GoogleIcon />
              <span>Continue with Google</span>
              <ArrowIcon />
            </a>
          </div>

          <div data-slot="login-note">
            <span data-slot="status-dot" aria-hidden="true" />
            First sign-in creates your Zaovra account.
          </div>
          <p data-slot="legal-copy">
            By continuing, you agree to the <A href={language.route("/legal/terms-of-service")}>Terms</A> and <A href={language.route("/legal/privacy-policy")}>Privacy Policy</A>.
          </p>
        </div>
      </section>
    </main>
  )
}
