import "./index.css"
import "./home-authkit-foundation.css"
import "./home-authkit-stages.css"
import "./home-authkit-motion.css"
import "./home-impeccable-polish.css"
import "./home-navigation.css"
import { Meta, Title } from "@solidjs/meta"
import { A } from "@solidjs/router"
import { Tabs } from "@kobalte/core/tabs"
import { useSpring } from "@zaovra-ai/ui/motion-spring"
import { createSignal, onCleanup } from "solid-js"
import logo from "../asset/logo-ornate-dark.svg"
import logoSquare from "../asset/brand/zaovra-logo-light-square.png"
import appScreenshot from "../asset/lander/zaovra-app-session.png"
import appScreenshotMobile from "../asset/lander/zaovra-app-session-mobile.png"
import { IconCheck, IconCopy } from "../component/icon"
import { ProviderStage, WorkGraphPreviewStage } from "~/component/home-product-stages"
import { Footer } from "~/component/footer"
import { Legal } from "~/component/legal"
import { LocaleLinks } from "~/component/locale-links"
import { config } from "~/config"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11M11 6l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3v9m0 0 3.5-3.5M10 12 6.5 8.5M4 16h12" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4.25 6.25 3.75 3.5 3.75-3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  )
}

function KeyholeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.75a6.25 6.25 0 0 0-2 12.17v3.83h4v-3.83A6.25 6.25 0 0 0 12 3.75Z" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M12 9.5v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  )
}

function ProviderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7.25h16M6.5 12h11M9 16.75h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      <circle cx="7" cy="7.25" r="1.4" fill="currentColor" />
      <circle cx="15" cy="12" r="1.4" fill="currentColor" />
      <circle cx="11" cy="16.75" r="1.4" fill="currentColor" />
    </svg>
  )
}

function EndpointIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 7H5.75A2.75 2.75 0 0 0 3 9.75v4.5A2.75 2.75 0 0 0 5.75 17H8m8-10h2.25A2.75 2.75 0 0 1 21 9.75v4.5A2.75 2.75 0 0 1 18.25 17H16m-7-5h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  )
}

function HomeNavigation(props: { route: (path: string) => string }) {
  const [byokOpen, setByokOpen] = createSignal(false)
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const cancelClose = () => {
    if (!closeTimer) return
    clearTimeout(closeTimer)
    closeTimer = undefined
  }
  const open = () => {
    cancelClose()
    setByokOpen(true)
  }
  const close = () => {
    cancelClose()
    closeTimer = setTimeout(() => setByokOpen(false), 120)
  }
  onCleanup(cancelClose)

  return (
    <>
      <nav data-slot="primary-nav" aria-label="Homepage navigation">
        <A href={props.route("/go")}>Pricing</A>
        <div
          data-component="nav-flyout"
          data-open={byokOpen() ? "" : undefined}
          onPointerEnter={open}
          onPointerLeave={close}
          onFocusIn={open}
          onFocusOut={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
            close()
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return
            setByokOpen(false)
            ;(event.currentTarget.querySelector("button") as HTMLButtonElement | null)?.focus()
          }}
        >
          <button type="button" aria-expanded={byokOpen()} aria-controls="byok-nav-menu" onClick={() => setByokOpen((value) => !value)}>
            BYOK
            <ChevronIcon />
          </button>
          <div id="byok-nav-menu" data-slot="nav-dropdown" aria-hidden={!byokOpen()}>
            <a href="#byok" data-slot="nav-menu-item" onClick={() => setByokOpen(false)}>
              <span data-slot="menu-icon"><KeyholeIcon /></span>
              <span><strong>How BYOK works</strong><small>Keep model access under your control.</small></span>
            </a>
            <A href={props.route("/docs/providers/")} data-slot="nav-menu-item" onClick={() => setByokOpen(false)}>
              <span data-slot="menu-icon"><ProviderIcon /></span>
              <span><strong>Supported providers</strong><small>See the providers and credentials Zaovra accepts.</small></span>
            </A>
            <A href={props.route("/docs/providers/")} data-slot="nav-menu-item" onClick={() => setByokOpen(false)}>
              <span data-slot="menu-icon"><EndpointIcon /></span>
              <span><strong>Custom endpoints</strong><small>Connect OpenAI-compatible and local endpoints.</small></span>
            </A>
          </div>
        </div>
        <A href={props.route("/download")}>Download</A>
        <A href={props.route("/docs")}>Docs</A>
        <A href={props.route("/about")}>About Us</A>
      </nav>
      <details data-component="mobile-nav">
        <summary>Menu <ChevronIcon /></summary>
        <nav aria-label="Mobile homepage navigation">
          <A href={props.route("/go")}>Pricing</A>
          <a href="#byok">BYOK</a>
          <A href={props.route("/docs/providers/")}>Provider docs</A>
          <A href={props.route("/download")}>Download</A>
          <A href={props.route("/docs")}>Docs</A>
          <A href={props.route("/about")}>About Us</A>
        </nav>
      </details>
    </>
  )
}

const featureIconGlyphs = {
  key: {
    mass: "M10.5 5.5a9 9 0 1 0 7.97 13.2H21v3h3v-3h4v-6.4h-9.53A9 9 0 0 0 10.5 5.5Z",
    accent: "M10.5 10.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
    detail: "M10.5 10.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm7.5 4h8m-4 0v3m3-3v2",
  },
  workspace: {
    mass: "M3.75 8.75A2.75 2.75 0 0 1 6.5 6h6l2.25 2.25H25.5A2.75 2.75 0 0 1 28.25 11v12.25A2.75 2.75 0 0 1 25.5 26H6.5a2.75 2.75 0 0 1-2.75-2.75V8.75Z",
    accent: "M7.25 14h17.5v8.25H7.25z",
    detail: "M4.75 11.75h22.5M9 17h14m-14 3.75h9.5",
  },
  review: {
    mass: "M6 3.75h13.25L26 10.5v15A2.5 2.5 0 0 1 23.5 28h-15A2.5 2.5 0 0 1 6 25.5V3.75Z",
    accent: "M19.25 3.75v6.75H26z",
    detail: "m10 20.25-3.25-3.2 1.9-1.9L16 18.45l7.35-7.35 1.9 1.9L16 22.25Z",
  },
  explore: {
    mass: "M13.25 4.25a9 9 0 1 0 5.33 16.25l6.96 6.96 1.92-1.92-6.96-6.96a9 9 0 0 0-7.25-14.33Z",
    accent: "M8.75 10h8.75v2.5H8.75zm0 5h6.25v2.5H8.75z",
    detail: "M13.25 6.75a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm4.7 11.2 7.35 7.35",
  },
  plan: {
    mass: "M7 5.5h18a2 2 0 0 1 2 2v19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-19a2 2 0 0 1 2-2Z",
    accent: "M11 3.25h10v5H11zM10 13h3v3h-3zm0 7h3v3h-3z",
    detail: "M10.5 14.25 12 15.75l3-3M16.5 14h6M10.5 21.25 12 22.75l3-3m1.5 1.25h6",
  },
  execute: {
    mass: "M3.5 6.25A2.75 2.75 0 0 1 6.25 3.5h19.5a2.75 2.75 0 0 1 2.75 2.75v19.5a2.75 2.75 0 0 1-2.75 2.75H6.25a2.75 2.75 0 0 1-2.75-2.75V6.25Z",
    accent: "M3.5 6.25A2.75 2.75 0 0 1 6.25 3.5h19.5a2.75 2.75 0 0 1 2.75 2.75V9H3.5V6.25Z",
    detail: "m8.5 14 4 4-4 4m7.25 0H23",
  },
  verify: {
    mass: "M16 3.25 27 8v7.5c0 7-4.46 11.17-11 13.25C9.46 26.67 5 22.5 5 15.5V8l11-4.75Z",
    accent: "M16 7.25 23.5 10.5v5c0 4.48-2.6 7.35-7.5 9.2Z",
    detail: "m10.25 15.75 3.5 3.5 7.5-8",
  },
  sessions: {
    mass: "M7.5 3.75h19A2.5 2.5 0 0 1 29 6.25v14.5a2.5 2.5 0 0 1-2.5 2.5h-19A2.5 2.5 0 0 1 5 20.75V6.25a2.5 2.5 0 0 1 2.5-2.5Z",
    accent: "M3 9h3v12.25h19V25H5.5A2.5 2.5 0 0 1 3 22.5V9Z",
    detail: "M10 9h14m-14 4.5h10m-10 4.5h7",
  },
  diff: {
    mass: "M4.5 4.25h8.75v23.5H4.5zM18.75 4.25h8.75v23.5h-8.75z",
    accent: "M7.25 7h3.25v18H7.25zm14.25 0h3.25v18H21.5z",
    detail: "M12.75 11h7m-2.75-2.75L19.75 11 17 13.75M19.25 21h-7M15 18.25 12.25 21 15 23.75",
  },
  terminal: {
    mass: "M3.5 5A2.5 2.5 0 0 1 6 2.5h20A2.5 2.5 0 0 1 28.5 5v22A2.5 2.5 0 0 1 26 29.5H6A2.5 2.5 0 0 1 3.5 27V5Z",
    accent: "M3.5 5A2.5 2.5 0 0 1 6 2.5h20A2.5 2.5 0 0 1 28.5 5v4H3.5V5Z",
    detail: "m8.5 14 4 4-4 4m7.5 0H23M8 5.75h.01m4 0h.01m4 0h.01",
  },
} as const

function FeatureIcon(props: { name: keyof typeof featureIconGlyphs }) {
  const [x, setX] = createSignal(0)
  const [y, setY] = createSignal(0)
  const springX = useSpring(x)
  const springY = useSpring(y)
  const reset = () => {
    setX(0)
    setY(0)
  }

  return (
    <span
      data-component="feature-icon"
      data-icon={props.name}
      aria-hidden="true"
      style={`--icon-magnet-x:${springX()}px;--icon-magnet-y:${springY()}px`}
      onPointerMove={(event) => {
        if (event.pointerType === "touch" || window.matchMedia("(prefers-reduced-motion: reduce), (pointer: coarse)").matches) {
          reset()
          return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        setX(Math.max(-12.8, Math.min(12.8, ((event.clientX - rect.x - rect.width / 2) / 30) * 16)))
        setY(Math.max(-12.8, Math.min(12.8, ((event.clientY - rect.y - rect.height / 2) / 30) * 16)))
      }}
      onPointerLeave={reset}
      onPointerCancel={reset}
    >
      <span data-slot="icon-core">
        <svg viewBox="0 0 32 32">
          <path data-layer="mass" d={featureIconGlyphs[props.name].mass} />
          <path data-layer="accent" d={featureIconGlyphs[props.name].accent} />
          <path data-layer="detail" d={featureIconGlyphs[props.name].detail} />
        </svg>
      </span>
    </span>
  )
}

function CopyStatus() {
  return (
    <span data-component="copy-status" aria-hidden="true">
      <IconCopy data-slot="copy" />
      <IconCheck data-slot="check" />
    </span>
  )
}

export default function Home() {
  const i18n = useI18n()
  const language = useLanguage()
  const handleCopyClick = (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement
    const command = button.dataset.command
    if (!command) return
    void navigator.clipboard.writeText(command)
    button.setAttribute("data-copied", "")
    setTimeout(() => button.removeAttribute("data-copied"), 1500)
  }

  return (
    <main data-page="zaovra-home">
      <Title>{i18n.t("home.next.metaTitle")}</Title>
      <Meta name="description" content={i18n.t("home.next.metaDescription")} />
      <Meta property="og:image" content="/social-share.png" />
      <Meta name="twitter:image" content="/social-share.png" />
      <LocaleLinks path="/" />

      <header data-component="home-header">
        <div data-slot="header-inner">
          <A href={language.route("/")} data-slot="brand" aria-label={i18n.t("nav.logoAlt")}>
            <img src={logo} alt={i18n.t("nav.logoAlt")} width="140" height="32" />
          </A>
          <HomeNavigation route={language.route} />
          <A href={language.route("/login")} data-slot="header-cta">
            Log in
          </A>
        </div>
      </header>

      <div data-component="home-content">
        <section data-component="home-hero" id="product">
          <div data-slot="hero-copy">
            <div data-slot="eyebrow">
              <span data-slot="status-dot" />
              {i18n.t("home.next.hero.eyebrow")}
            </div>
            <h1>{i18n.t("home.next.hero.title")}</h1>
            <p>{i18n.t("home.next.hero.body")}</p>
            <div data-slot="hero-actions">
              <A href={language.route("/download")} data-variant="primary">
                <DownloadIcon />
                {i18n.t("home.next.action.downloadBeta")}
              </A>
              <a href={config.github.repoUrl} target="_blank" rel="noreferrer" data-variant="secondary">
                {i18n.t("home.next.action.github")}
                <ArrowIcon />
              </a>
            </div>
            <p data-slot="platform-note">{i18n.t("home.next.hero.platforms")}</p>
          </div>
          <div data-slot="hero-product">
            <figure data-component="real-app-preview">
              <div data-slot="real-app-frame">
                <picture>
                  <source media="(max-width: 719px)" srcset={appScreenshotMobile} />
                  <img
                    src={appScreenshot}
                    alt="Zaovra new-session interface with model selection and a local project workspace"
                    width="800"
                    height="460"
                  />
                </picture>
              </div>
              <figcaption>
                <span>Actual Zaovra interface</span>
                <span>New session · local workspace</span>
              </figcaption>
            </figure>
          </div>
        </section>

        <section data-component="proof-rail" aria-label={i18n.t("home.next.proof.ariaLabel")}>
          <div>
            <FeatureIcon name="key" />
            <strong>{i18n.t("home.next.proof.byok.title")}</strong>
            <p>{i18n.t("home.next.proof.byok.body")}</p>
          </div>
          <div>
            <FeatureIcon name="workspace" />
            <strong>{i18n.t("home.next.proof.workspace.title")}</strong>
            <p>{i18n.t("home.next.proof.workspace.body")}</p>
          </div>
          <div>
            <FeatureIcon name="review" />
            <strong>{i18n.t("home.next.proof.review.title")}</strong>
            <p>{i18n.t("home.next.proof.review.body")}</p>
          </div>
        </section>

        <section data-component="workflow" data-layout="section">
          <div data-slot="section-heading">
            <span>{i18n.t("home.next.workflow.kicker")}</span>
            <h2>{i18n.t("home.next.workflow.title")}</h2>
            <p>{i18n.t("home.next.workflow.body")}</p>
          </div>
          <div data-component="capability-stage">
            <div data-slot="capability-atmosphere" aria-hidden="true">
              {Array.from({ length: 14 }, () => (
                <span />
              ))}
            </div>
            <header data-slot="capability-chrome">
              <span data-slot="window-controls" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>zaovra / workspace runtime</span>
              <span data-slot="runtime-state"><i /> local</span>
            </header>
            <div data-slot="capability-scene">
              <div data-slot="depth-plane" aria-hidden="true" />
              <svg data-slot="capability-links" viewBox="0 0 1120 610" preserveAspectRatio="none" aria-hidden="true">
                <path d="M264 142H350Q390 142 420 186" />
                <path d="M856 138H770Q730 138 700 186" />
                <path d="M252 448H350Q390 448 420 410" />
                <path d="M868 450H770Q730 450 700 410" />
                <path data-slot="link-signal" d="M264 142H350Q390 142 420 186" />
                <path data-slot="link-signal" d="M868 450H770Q730 450 700 410" />
              </svg>

              <article data-slot="capability-module" data-module="providers">
                <header>
                  <FeatureIcon name="key" />
                  <span>BYOK</span>
                </header>
                <strong>{i18n.t("home.next.proof.byok.title")}</strong>
                <p>{i18n.t("home.next.proof.byok.body")}</p>
                <div data-slot="provider-marks" aria-label="Supported provider examples">
                  <span>A</span><span>O</span><span>G</span><span>API</span>
                </div>
              </article>

              <article data-slot="capability-module" data-module="workspace">
                <header>
                  <FeatureIcon name="workspace" />
                  <span>Workspace</span>
                </header>
                <strong>{i18n.t("home.next.proof.workspace.title")}</strong>
                <p>{i18n.t("home.next.proof.workspace.body")}</p>
                <div data-slot="path-preview"><span>src</span><span>routes</span><strong>index.tsx</strong></div>
              </article>

              <section data-slot="capability-console" aria-label="Zaovra workspace capability overview">
                <header>
                  <img src={logoSquare} alt="" width="58" height="58" />
                  <span>
                    <small>Zaovra workspace</small>
                    <strong>Grounded coding session</strong>
                  </span>
                  <i>Working</i>
                </header>
                <div data-slot="console-context">
                  <span><small>Project</small><strong>zaovra / console</strong></span>
                  <span><small>Model access</small><strong>BYOK · connected</strong></span>
                </div>
                <ol data-slot="capability-flow">
                  <li data-state="complete"><FeatureIcon name="explore" /><span><strong>{i18n.t("home.next.workflow.explore.title")}</strong><small>{i18n.t("home.next.workflow.explore.body")}</small></span><i /></li>
                  <li data-state="complete"><FeatureIcon name="plan" /><span><strong>{i18n.t("home.next.workflow.plan.title")}</strong><small>{i18n.t("home.next.workflow.plan.body")}</small></span><i /></li>
                  <li data-state="active"><FeatureIcon name="execute" /><span><strong>{i18n.t("home.next.workflow.execute.title")}</strong><small>{i18n.t("home.next.workflow.execute.body")}</small></span><i /></li>
                  <li><FeatureIcon name="verify" /><span><strong>{i18n.t("home.next.workflow.review.title")}</strong><small>{i18n.t("home.next.workflow.review.body")}</small></span><i /></li>
                </ol>
                <footer><span><i /> Session retained</span><span>Terminal connected</span></footer>
              </section>

              <article data-slot="capability-module" data-module="sessions">
                <header>
                  <FeatureIcon name="sessions" />
                  <span>Sessions</span>
                </header>
                <strong>{i18n.t("home.next.workbench.sessions.title")}</strong>
                <p>{i18n.t("home.next.workbench.sessions.body")}</p>
                <div data-slot="session-preview"><span data-active="true">Homepage refresh</span><span>Provider flow</span></div>
              </article>

              <article data-slot="capability-module" data-module="review">
                <header>
                  <FeatureIcon name="diff" />
                  <span>Review</span>
                </header>
                <strong>{i18n.t("home.next.workbench.review.title")}</strong>
                <p>{i18n.t("home.next.workbench.review.body")}</p>
                <div data-slot="diff-preview"><span data-kind="remove">− 1</span><span data-kind="add">+ 4</span><span>index.tsx</span></div>
              </article>

              <aside data-slot="tool-ribbon">
                <FeatureIcon name="terminal" />
                <span><strong>{i18n.t("home.next.workbench.tools.title")}</strong><small>{i18n.t("home.next.workbench.tools.body")}</small></span>
                <i>LSP · ready</i>
              </aside>
            </div>
            <footer data-slot="capability-support">
              <span>Local workspace</span><span>BYOK providers</span><span>Durable sessions</span><span>Terminal + LSP</span><span>Reviewable diffs</span>
            </footer>
          </div>
        </section>

        <section data-component="workbench-detail" data-layout="section">
          <div data-slot="section-heading">
            <span>{i18n.t("home.next.workbench.kicker")}</span>
            <h2>{i18n.t("home.next.workbench.title")}</h2>
            <p>{i18n.t("home.next.workbench.body")}</p>
          </div>
          <div data-slot="feature-grid">
            <article>
              <FeatureIcon name="sessions" />
              <h3>{i18n.t("home.next.workbench.sessions.title")}</h3>
              <p>{i18n.t("home.next.workbench.sessions.body")}</p>
            </article>
            <article>
              <FeatureIcon name="diff" />
              <h3>{i18n.t("home.next.workbench.review.title")}</h3>
              <p>{i18n.t("home.next.workbench.review.body")}</p>
            </article>
            <article>
              <FeatureIcon name="terminal" />
              <h3>{i18n.t("home.next.workbench.tools.title")}</h3>
              <p>{i18n.t("home.next.workbench.tools.body")}</p>
            </article>
          </div>
        </section>

        <section data-component="byok" data-layout="section" id="byok">
          <div data-slot="byok-copy">
            <div data-slot="section-heading">
              <span>{i18n.t("home.next.byok.kicker")}</span>
              <h2>{i18n.t("home.next.byok.title")}</h2>
              <p>{i18n.t("home.next.byok.body")}</p>
            </div>
            <ul data-slot="check-list">
              <li>{i18n.t("home.next.byok.account")}</li>
              <li>{i18n.t("home.next.byok.providers")}</li>
              <li>{i18n.t("home.next.byok.endpoint")}</li>
            </ul>
            <A href={language.route("/docs/providers/#directory")} data-slot="text-link">
              {i18n.t("home.next.action.providerDocs")}
              <ArrowIcon />
            </A>
          </div>
          <ProviderStage />
        </section>

        <section data-component="workgraph" data-layout="section" id="workgraph">
          <div data-slot="workgraph-copy">
            <div data-slot="preview-badge">{i18n.t("home.next.workgraph.badge")}</div>
            <div data-slot="section-heading">
              <span>{i18n.t("home.next.workgraph.kicker")}</span>
              <h2>{i18n.t("home.next.workgraph.title")}</h2>
              <p>{i18n.t("home.next.workgraph.body")}</p>
            </div>
            <ul data-slot="check-list">
              <li>{i18n.t("home.next.workgraph.goal")}</li>
              <li>{i18n.t("home.next.workgraph.control")}</li>
              <li>{i18n.t("home.next.workgraph.evidence")}</li>
            </ul>
          </div>
          <WorkGraphPreviewStage />
        </section>

        <section data-component="open-local" data-layout="section">
          <div data-slot="section-heading">
            <span>{i18n.t("home.next.open.kicker")}</span>
            <h2>{i18n.t("home.next.open.title")}</h2>
          </div>
          <div data-slot="open-grid">
            <article>
              <h3>{i18n.t("home.next.open.workspace.title")}</h3>
              <p>{i18n.t("home.next.open.workspace.body")}</p>
            </article>
            <article>
              <h3>{i18n.t("home.next.open.source.title")}</h3>
              <p>{i18n.t("home.next.open.source.body")}</p>
              <a href={config.github.repoUrl} target="_blank" rel="noreferrer" data-slot="text-link">
                {i18n.t("home.next.action.source")}
                <ArrowIcon />
              </a>
            </article>
          </div>
        </section>

        <section data-component="access-paths" data-layout="section">
          <div data-slot="section-heading">
            <span>{i18n.t("home.next.access.kicker")}</span>
            <h2>{i18n.t("home.next.access.title")}</h2>
            <p>{i18n.t("home.next.access.body")}</p>
          </div>
          <div data-slot="access-grid">
            <article data-variant="featured">
              <span>{i18n.t("home.next.access.byok.label")}</span>
              <h3>{i18n.t("home.next.access.byok.title")}</h3>
              <p>{i18n.t("home.next.access.byok.body")}</p>
              <ul>
                <li>{i18n.t("home.next.access.byok.point1")}</li>
                <li>{i18n.t("home.next.access.byok.point2")}</li>
              </ul>
            </article>
            <article>
              <span>{i18n.t("home.next.access.subscription.label")}</span>
              <h3>{i18n.t("home.next.access.subscription.title")}</h3>
              <p>{i18n.t("home.next.access.subscription.body")}</p>
              <ul>
                <li>{i18n.t("home.next.access.subscription.point1")}</li>
                <li>{i18n.t("home.next.access.subscription.point2")}</li>
              </ul>
            </article>
          </div>
        </section>

        <section data-component="home-faq" data-layout="section">
          <div data-slot="section-heading">
            <span>{i18n.t("home.next.faq.kicker")}</span>
            <h2>{i18n.t("home.next.faq.title")}</h2>
          </div>
          <div data-slot="faq-list">
            <details>
              <summary>{i18n.t("home.next.faq.account.q")}</summary>
              <p>{i18n.t("home.next.faq.account.a")}</p>
            </details>
            <details>
              <summary>{i18n.t("home.next.faq.local.q")}</summary>
              <p>{i18n.t("home.next.faq.local.a")}</p>
            </details>
            <details>
              <summary>{i18n.t("home.next.faq.workgraph.q")}</summary>
              <p>{i18n.t("home.next.faq.workgraph.a")}</p>
            </details>
            <details>
              <summary>{i18n.t("home.next.faq.desktop.q")}</summary>
              <p>{i18n.t("home.next.faq.desktop.a")}</p>
            </details>
            <details>
              <summary>{i18n.t("home.next.faq.open.q")}</summary>
              <p>{i18n.t("home.next.faq.open.a")}</p>
            </details>
          </div>
        </section>

        <section data-component="download-cta" data-layout="section">
          <div data-slot="cta-copy">
            <span>{i18n.t("home.next.download.kicker")}</span>
            <h2>{i18n.t("home.next.download.title")}</h2>
            <p>{i18n.t("home.next.download.body")}</p>
          </div>
          <div data-slot="download-actions">
            <A href={language.route("/download")} data-variant="primary">
              <DownloadIcon />
              {i18n.t("home.next.action.downloadBeta")}
            </A>
            <Tabs as="div" data-component="install-options" defaultValue="curl">
              <Tabs.List data-slot="install-tabs" aria-label={i18n.t("home.next.install.ariaLabel")}>
                <Tabs.Trigger value="curl">curl</Tabs.Trigger>
                <Tabs.Trigger value="npm">npm</Tabs.Trigger>
                <Tabs.Trigger value="bun">bun</Tabs.Trigger>
                <Tabs.Trigger value="brew">brew</Tabs.Trigger>
                <Tabs.Trigger value="paru">paru</Tabs.Trigger>
                <Tabs.Indicator />
              </Tabs.List>
              <div data-slot="install-panels">
                <Tabs.Content value="curl">
                  <button data-command="curl -fsSL https://zaovra.com/install | bash" onClick={handleCopyClick}>
                    <code>curl -fsSL <strong>https://zaovra.com/install</strong> | bash</code>
                    <CopyStatus />
                  </button>
                </Tabs.Content>
                <Tabs.Content value="npm">
                  <button data-command="npm i -g zaovra-ai" onClick={handleCopyClick}>
                    <code>npm i -g <strong>zaovra-ai</strong></code>
                    <CopyStatus />
                  </button>
                </Tabs.Content>
                <Tabs.Content value="bun">
                  <button data-command="bun add -g zaovra-ai" onClick={handleCopyClick}>
                    <code>bun add -g <strong>zaovra-ai</strong></code>
                    <CopyStatus />
                  </button>
                </Tabs.Content>
                <Tabs.Content value="brew">
                  <button data-command="brew install zuozizuozi/tap/zaovra" onClick={handleCopyClick}>
                    <code>brew install <strong>zuozizuozi/tap/zaovra</strong></code>
                    <CopyStatus />
                  </button>
                </Tabs.Content>
                <Tabs.Content value="paru">
                  <button data-command="paru -S zaovra" onClick={handleCopyClick}>
                    <code>paru -S <strong>zaovra</strong></code>
                    <CopyStatus />
                  </button>
                </Tabs.Content>
              </div>
            </Tabs>
          </div>
        </section>

        <Footer />
      </div>
      <Legal />
    </main>
  )
}
