import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { A } from "@solidjs/router"
import logo from "../../asset/logo-ornate-dark.svg"
import logoSquare from "../../asset/brand/zaovra-logo-light-square.png"
import { LocaleLinks } from "~/component/locale-links"
import { useLanguage } from "~/context/language"

export default function About() {
  const language = useLanguage()
  return (
    <main data-page="about">
      <Title>About Zaovra</Title>
      <Meta name="description" content="Why Zaovra is built around durable coding work, local context, BYOK, and reviewable execution." />
      <LocaleLinks path="/about" />

      <header data-component="about-header">
        <A href={language.route("/")} aria-label="Zaovra home"><img src={logo} alt="Zaovra" width="140" height="32" /></A>
        <nav aria-label="About page navigation">
          <A href={language.route("/go")}>Pricing</A>
          <A href={language.route("/download")}>Download</A>
          <A href={language.route("/docs")}>Docs</A>
          <A href={language.route("/login")} data-slot="login-link">Log in</A>
        </nav>
      </header>

      <div data-component="about-content">
        <section data-component="about-hero">
          <div data-slot="about-copy">
            <h1>Built for work that outlives a prompt.</h1>
            <p>
              Zaovra is a desktop coding agent shaped around the work developers actually need to keep: project context,
              long-running sessions, real execution, and changes that remain inspectable before they move forward.
            </p>
          </div>
          <div data-slot="about-mark" aria-hidden="true">
            <span><img src={logoSquare} alt="" /></span>
            <i /><i /><i />
          </div>
        </section>

        <section data-component="about-principles" aria-label="What Zaovra is built around">
          <article>
            <span>Local context</span>
            <h2>Your workspace stays part of the conversation.</h2>
            <p>Files, sessions, tools, and terminal output remain connected to the coding task instead of becoming isolated chat fragments.</p>
          </article>
          <article>
            <span>BYOK</span>
            <h2>Model access can stay under your control.</h2>
            <p>Use supported provider credentials and compatible endpoints without turning the marketing site into a key-management console.</p>
          </article>
          <article>
            <span>Reviewable execution</span>
            <h2>Changes stay visible before they become final.</h2>
            <p>Zaovra keeps edits, commands, and their output close enough to inspect, verify, and continue with context intact.</p>
          </article>
        </section>

        <section data-component="about-actions">
          <div><h2>See how Zaovra fits your workflow.</h2><p>Explore the product, then choose BYOK or managed access when you are ready.</p></div>
          <div>
            <A href={language.route("/download")} data-variant="primary">Download Zaovra</A>
            <A href={language.route("/docs")}>Read the docs</A>
          </div>
        </section>
      </div>
    </main>
  )
}
