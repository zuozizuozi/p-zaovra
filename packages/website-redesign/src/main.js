import "./styles.css"
import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"

gsap.registerPlugin(ScrollTrigger)

const capabilities = [
  ["Understands the architecture", "Build a working map of the repository, its conventions, and the files that matter before changing code."],
  ["Coordinates agents", "Give focused work to parallel agents, keep the shared objective visible, and bring results back into one reviewable change."],
  ["Uses terminal + tools", "Search, edit, run commands, inspect results, and keep the actual workspace at the center of every decision."],
  ["Keeps sessions durable", "Admit work before execution, resume long tasks safely, and keep context available beyond one provider turn."],
  ["Connects any model", "Bring your own provider and select the model that fits the task, without moving the repository into a hosted black box."],
  ["Produces reviewable diffs", "Changes stay visible as code. Permissions, tool calls, and final diffs remain available for human review."],
]

const faqs = [
  ["What is Zaovra?", "Zaovra is an open-source, local-first AI coding workspace for running agents against real repositories with durable context and reviewable output."],
  ["What does local-first mean?", "Your workspace and execution environment remain local. Zaovra grounds agents in the files, tools, and project state already on your machine."],
  ["Can I choose my model provider?", "Yes. Zaovra is designed for bring-your-own-key workflows and multi-model routing, so the provider stays your choice."],
  ["How does Zaovra handle project data?", "Project context is read from the local workspace. Every external model request still follows the provider and permissions you configure."],
  ["Can I use it from the terminal only?", "Yes. The terminal workflow is first-class, and the same project can also be used through desktop and IDE surfaces."],
  ["Is there a desktop app?", "Yes. Zaovra supports desktop, terminal, and IDE workflows so you can choose the surface that fits the task."],
  ["How does it keep project context?", "Zaovra combines workspace grounding with durable sessions, then reloads the relevant history and tool state at safe execution boundaries."],
  ["Is Zaovra open source?", "Yes. The codebase is open source, so teams can inspect the runtime, extend tools, and keep their workflow portable."],
]

const languageItems = ["English", "简体中文", "繁體中文", "日本語", "한국어", "Deutsch", "Español", "Français", "Português"]

document.querySelector("#app").innerHTML = `
  <a class="skip-link" href="#top">Skip to content</a>
  <header class="site-header">
    <a class="brand" href="#top" aria-label="Zaovra home">
      <img src="/assets/zaovra-wordmark-light.svg" alt="Zaovra" />
    </a>
    <nav class="desktop-nav" aria-label="Primary navigation">
      <a href="#product">Product</a><a href="#workflow">Workflows</a><a href="#faq">Docs</a><a href="https://github.com/zaovra" target="_blank" rel="noreferrer">GitHub</a>
    </nav>
    <div class="header-actions">
      <div class="language">
        <button class="language-trigger" type="button" aria-expanded="false" aria-haspopup="menu"><span>EN</span><span aria-hidden="true">⌄</span></button>
        <div class="language-popover" role="menu" hidden>${languageItems.map((language, index) => `<button type="button" role="menuitemradio" aria-checked="${index === 0}" data-language="${language}">${language}</button>`).join("")}</div>
      </div>
      <a class="button button-dark header-cta" href="#install">Download beta <span>↗</span></a>
      <button class="menu-toggle" type="button" aria-expanded="false" aria-label="Open navigation"><i></i><i></i></button>
    </div>
  </header>

  <main id="top">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero-geometry" aria-hidden="true"><span class="orbit orbit-a"></span><span class="orbit orbit-b"></span><span class="cursor-mark">Z</span></div>
      <div class="hero-copy rail">
        <h1 id="hero-title">Engineering context.<br />Kept in motion.</h1>
        <p>An open-source, local-first coding workspace that keeps sessions durable, execution visible, and every change ready to review.</p>
        <div class="hero-actions">
          <a class="button button-dark" href="#install">Download Zaovra <span>↗</span></a>
          <a class="button button-outline-dark" href="#product">See how it works <span>↓</span></a>
        </div>
      </div>
      <div class="ticker" aria-label="Zaovra features"><div class="ticker-track">${Array(2).fill(["LOCAL WORKSPACE", "DURABLE SESSIONS", "MULTI-MODEL", "REVIEWABLE DIFFS", "TERMINAL", "DESKTOP", "IDE"]).flat().map((item) => `<span>${item}</span>`).join("")}</div></div>
    </section>

    <section class="problem-section dark-section section-pad" id="product">
      <div class="rail">
        <div class="center-heading"><span class="signal-label">Context drift</span><h2>Code keeps moving.<br />Most AI loses the thread.</h2></div>
        <div class="problem-layout">
          <div class="radar" aria-label="Context drift diagnostic illustration">
            <div class="radar-rings"></div><div class="radar-axis"></div><div class="radar-core"></div>
            <span class="radar-readout">SESSION / 04<br />CONTEXT / FRAGMENTED<br />STATE / UNRESOLVED</span>
          </div>
          <div class="problem-grid">
            ${[
              ["CHAT MEMORY", "The chat knows the prompt", "Long-running work needs the repository, current branch, tool results, and why each decision was made."],
              ["SESSION BREAKS", "The context was written", "A transcript is not execution state. When the provider turn ends, important working context can disappear."],
              ["MODEL LOCK-IN", "They choose the model", "One hosted assistant turns provider choice and project access into platform policy."],
              ["REVIEW GAP", "They control your flow", "Opaque automation makes it hard to see what ran, what changed, and what should be trusted."],
            ].map(([label, title, text]) => `<article class="problem-card"><span>${label}</span><h3>${title}</h3><p>${text}</p></article>`).join("")}
          </div>
        </div>
      </div>
    </section>

    <section class="local-flow dark-section section-pad" id="workflow">
      <div class="rail">
        <div class="center-heading"><span class="signal-label">Local system</span><h2>Everything connected.<br />Own the workflow.</h2><p>Your files, terminal, tools, permissions, model choice, and output remain part of one understandable system.</p></div>
        <div class="flow-diagram" aria-label="Zaovra local workflow diagram">
          <div class="flow-node flow-node-top muted-node">VENDOR CLOUD<span>optional provider boundary</span></div>
          <div class="flow-cut">×</div>
          <div class="flow-row"><div class="flow-node">WORKSPACE<span>files · git · rules</span></div><i></i><div class="flow-node active-node">ZAOVRA RUNTIME<span>context · session · tools</span></div><i></i><div class="flow-node">MODEL / PROVIDER<span>your key · your choice</span></div></div>
          <div class="flow-down"></div><div class="flow-node flow-node-bottom">REVIEWABLE DIFF<span>inspect before merge</span></div>
        </div>
      </div>
    </section>

    <section class="continuity dark-section section-pad">
      <div class="rail">
        <div class="continuity-main">
          <div class="session-map" aria-label="Durable session flow">
            ${["SESSION", "INPUT ADMITTED", "TOOLS RUN", "DIFF READY"].map((item, index) => `<button type="button" class="checkpoint ${index === 1 ? "live" : ""}" id="session-step-${index}" aria-controls="session-preview" aria-pressed="${index === 1}"><span>${String(index + 1).padStart(2, "0")}</span><b>${item}</b></button>`).join("")}
          </div>
          <div class="continuity-copy"><h2>Resume the work,<br />not the setup.</h2><p>Durable sessions keep admitted work, relevant history, and execution boundaries available when a task spans providers, tools, or time.</p></div>
        </div>
        <div class="value-grid">${[
          ["Durable sessions", "Work is admitted before execution and can continue from a known state."],
          ["Your providers", "Route work to the model you choose with your own credentials."],
          ["Review before merge", "Keep permissions, tool activity, and final diffs visible to people."],
        ].map(([title, text]) => `<article><h3>${title}</h3><p>${text}</p></article>`).join("")}</div>
      </div>
    </section>

    <section class="approach dark-section section-pad">
      <div class="rail">
        <div class="center-heading"><span class="signal-label">The approach</span><h2>Purpose sets the sequence.</h2><p>Zaovra separates understanding, durable admission, and controlled execution so agents can move quickly without losing the human checkpoint.</p></div>
        <div class="approach-layout">
          <div class="steps" role="tablist" aria-label="Zaovra approach">
            ${[
              ["Ground the workspace", "Map project files, conventions, current state, and the exact scope before code changes begin.", "Context is selected from the repository, not reconstructed from a generic chat."],
              ["Admit work durably", "Record the user input and delivery mode before scheduling execution.", "Session continuity stays separate from any single model response or process lifetime."],
              ["Execute with control", "Run agents and tools against explicit permissions, then return a reviewable diff.", "People remain in charge of risky actions and the final merge."],
            ].map(([title, a, b], index) => `<button class="step ${index === 0 ? "active" : ""}" role="tab" aria-selected="${index === 0}" data-step="${index}"><strong>${title}</strong><div class="step-copy"><p>${a}</p><p>${b}</p></div></button>`).join("")}
          </div>
          <div class="approach-visual" aria-live="polite">
            <div class="panel-heading"><span>ZAOVRA / CONTEXT GRAPH</span><i></i><span>READY</span></div>
            <div class="panel-stage">
              <div class="context-orbit"><span>workspace</span><span>rules</span><span>history</span><span>tools</span><b>Z</b></div>
              <div class="ledger" hidden><span>session_input</span><span>admitted</span><span>queued</span><span>ready</span></div>
              <div class="gates" hidden><span>read files</span><span>run command</span><span>review diff</span></div>
            </div>
            <p class="panel-caption">PROJECT CONTEXT / LINKED AND CURRENT</p>
          </div>
        </div>
      </div>
    </section>

    <section class="capabilities dark-section section-pad">
      <div class="rail">
        <div class="center-heading"><h2>Your machine, coordinated.</h2></div>
        <div class="capability-grid">${capabilities.map(([title, copy]) => `<article><h3>${title}</h3><p>${copy}</p></article>`).join("")}</div>
        <div class="stats-strip">${[["OPEN", "Open source"], ["LOCAL", "Workspace context"], ["ANY", "Multi-model"], ["3", "Terminal · Desktop · IDE"]].map(([value, label]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join("")}</div>
      </div>
    </section>

    <section class="terminal-section dark-section section-pad">
      <div class="rail">
        <div class="center-heading"><span class="signal-label">Product surface</span><h2>Built for the whole build.</h2><p>One workspace for conversation, execution, project state, and the change you will actually ship.</p></div>
        <div class="product-stage">
          <div class="product-grid-lines"></div>
          <figure class="product-shot"><img src="/assets/screenshot-vscode.png" alt="Zaovra running inside a code editor" /></figure>
          ${[
            ["agent mode", "Orchestrated work"], ["provider routing", "Model choice"], ["permission gate", "Human control"],
            ["live tools", "Visible execution"], ["session state", "Durable context"], ["diff review", "Reviewable output"],
          ].map(([label, title], i) => `<div class="callout callout-${i + 1}"><span>${label}</span><strong>${title}</strong></div>`).join("")}
        </div>
      </div>
    </section>

    <section class="install dark-section section-pad" id="install">
      <div class="rail">
        <div class="install-box"><h2>Start where your code lives.</h2><div class="install-row"><code>curl -fsSL https://zaovra.com/install | bash</code><button class="copy-button" type="button">Copy</button><a class="button button-blue" href="https://zaovra.com/download" target="_blank" rel="noreferrer">Download desktop <span>↗</span></a></div></div>
      </div>
    </section>

    <section class="faq dark-section section-pad" id="faq">
      <div class="rail"><div class="center-heading"><h2>Frequently asked questions.</h2></div><div class="faq-list">${faqs.map(([q, a]) => `<div class="faq-item"><button type="button" aria-expanded="false"><strong>${q}</strong><i aria-hidden="true">+</i></button><div class="faq-answer"><p>${a}</p></div></div>`).join("")}</div></div>
    </section>

    <section class="final-cta dark-section">
      <div class="cta-rings" aria-hidden="true"></div><div class="final-copy"><img src="/assets/zaovra-logo-dark-square.png" alt="" /><h2>Keep the whole build<br />in context.</h2><a class="button button-blue" href="#install">Download Zaovra <span>↗</span></a><p>Open source · local-first · built for review</p></div>
    </section>
  </main>

  <footer class="site-footer dark-section"><div class="rail footer-grid"><div class="footer-brand"><img src="/assets/zaovra-wordmark-light.svg" alt="Zaovra" /><p>A local-first AI coding workspace for durable, reviewable engineering work.</p></div><div><strong>Product</strong><a href="#product">Overview</a><a href="#workflow">Workflows</a><a href="#install">Download</a></div><div><strong>Resources</strong><a href="#faq">Documentation</a><a href="#faq">FAQ</a><a href="https://github.com/zaovra" target="_blank" rel="noreferrer">GitHub</a></div><div><strong>Community</strong><a href="https://github.com/zaovra" target="_blank" rel="noreferrer">Contribute</a><a href="https://github.com/zaovra/issues" target="_blank" rel="noreferrer">Issues</a><a href="https://github.com/zaovra/releases" target="_blank" rel="noreferrer">Releases</a></div></div><div class="rail footer-bottom"><span>© 2026 ZAOVRA. OPEN SOURCE.</span><span>LOCAL RUNTIME / ONLINE</span></div></footer>
`

const languageTrigger = document.querySelector(".language-trigger")
const languagePopover = document.querySelector(".language-popover")
const closeLanguage = () => {
  languagePopover.hidden = true
  languageTrigger.setAttribute("aria-expanded", "false")
}

languageTrigger.addEventListener("click", () => {
  const open = languagePopover.hidden
  languagePopover.hidden = !open
  languageTrigger.setAttribute("aria-expanded", String(open))
})

document.addEventListener("click", (event) => {
  if (!event.target.closest(".language")) closeLanguage()
})

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeLanguage()
})

languagePopover.addEventListener("click", (event) => {
  const option = event.target.closest("[data-language]")
  if (!option) return
  languagePopover.querySelectorAll("[data-language]").forEach((item) => item.setAttribute("aria-checked", String(item === option)))
  languageTrigger.querySelector("span").textContent = option.dataset.language === "English" ? "EN" : option.dataset.language.slice(0, 2)
  closeLanguage()
})

const menuToggle = document.querySelector(".menu-toggle")
menuToggle.addEventListener("click", () => {
  const open = document.body.classList.toggle("menu-open")
  menuToggle.setAttribute("aria-expanded", String(open))
  menuToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation")
})

document.querySelectorAll(".desktop-nav a").forEach((link) => link.addEventListener("click", () => {
  document.body.classList.remove("menu-open")
  menuToggle.setAttribute("aria-expanded", "false")
  menuToggle.setAttribute("aria-label", "Open navigation")
}))

window.matchMedia("(min-width: 761px)").addEventListener("change", (event) => {
  if (!event.matches) return
  document.body.classList.remove("menu-open")
  menuToggle.setAttribute("aria-expanded", "false")
  menuToggle.setAttribute("aria-label", "Open navigation")
})

const panels = [document.querySelector(".context-orbit"), document.querySelector(".ledger"), document.querySelector(".gates")]
const panelHeadings = ["ZAOVRA / CONTEXT GRAPH", "ZAOVRA / SESSION LEDGER", "ZAOVRA / PERMISSION GATES"]
const panelCaptions = ["PROJECT CONTEXT / LINKED AND CURRENT", "SESSION INPUT / DURABLY ADMITTED", "EXECUTION / HUMAN CHECKPOINTS ACTIVE"]
document.querySelectorAll(".step").forEach((step) => step.addEventListener("click", () => {
  const index = Number(step.dataset.step)
  document.querySelectorAll(".step").forEach((item) => {
    const active = item === step
    item.classList.toggle("active", active)
    item.setAttribute("aria-selected", String(active))
  })
  panels.forEach((panel, panelIndex) => { panel.hidden = panelIndex !== index })
  document.querySelector(".panel-heading span").textContent = panelHeadings[index]
  document.querySelector(".panel-caption").textContent = panelCaptions[index]
}))

document.querySelectorAll(".faq-item button").forEach((button) => button.addEventListener("click", () => {
  const item = button.closest(".faq-item")
  const opening = !item.classList.contains("open")
  document.querySelectorAll(".faq-item").forEach((entry) => {
    entry.classList.remove("open")
    entry.querySelector("button").setAttribute("aria-expanded", "false")
  })
  if (!opening) return
  item.classList.add("open")
  button.setAttribute("aria-expanded", "true")
}))

document.querySelector(".copy-button").addEventListener("click", async (event) => {
  const button = event.currentTarget
  await navigator.clipboard.writeText(button.previousElementSibling.textContent)
  button.textContent = "Copied"
  window.setTimeout(() => { button.textContent = "Copy" }, 1400)
})

const motion = gsap.matchMedia()

motion.add({
  desktop: "(min-width: 761px)",
  finePointer: "(hover: hover) and (pointer: fine)",
  reduceMotion: "(prefers-reduced-motion: reduce)",
}, (context) => {
  if (context.conditions.reduceMotion) return

  const distance = context.conditions.desktop ? 28 : 18
  gsap.timeline({ defaults: { duration: 0.72, ease: "power3.out" } })
    .from(".site-header .brand, .desktop-nav a, .header-actions", { autoAlpha: 0, y: -12, stagger: 0.055 }, 0)
    .from(".hero h1", { autoAlpha: 0, y: 34, duration: 0.94 }, 0.1)
    .from(".hero-copy > p", { autoAlpha: 0, y: 18 }, 0.28)
    .from(".hero-actions", { y: 16 }, 0.34)
    .from(".hero-geometry", { autoAlpha: 0, scale: 0.9, rotation: -3, duration: 1.15 }, 0.08)
    .from(".ticker", { autoAlpha: 0, y: 10 }, 0.62)

  gsap.to(".orbit-a", { y: -9, rotation: 1.2, duration: 5.6, ease: "sine.inOut", repeat: -1, yoyo: true })
  gsap.to(".orbit-b", { y: 8, x: -5, rotation: -1.5, duration: 6.8, ease: "sine.inOut", repeat: -1, yoyo: true })

  gsap.timeline({
    defaults: { duration: 0.72, ease: "power3.out" },
    scrollTrigger: { trigger: ".problem-section", start: "top 78%", toggleActions: "play none none reverse" },
  })
    .from(".problem-section .center-heading > *", { autoAlpha: 0, y: distance, stagger: 0.08 }, 0)
    .from(".radar-rings", { autoAlpha: 0, scale: 0.82, rotation: -8, transformOrigin: "center" }, 0.16)
    .from(".radar-axis, .radar-core, .radar-readout", { autoAlpha: 0, scale: 0.92, stagger: 0.08 }, 0.3)
    .from(".problem-card", { autoAlpha: 0, y: 18, stagger: 0.08 }, 0.22)

  gsap.timeline({
    defaults: { duration: 0.68, ease: "power3.out" },
    scrollTrigger: { trigger: ".local-flow", start: "top 76%", toggleActions: "play none none reverse" },
  })
    .from(".local-flow .center-heading > *", { y: distance, stagger: 0.07 }, 0)
    .from(".flow-node, .flow-row i, .flow-cut, .flow-down", { autoAlpha: 0, scale: 0.88, stagger: 0.075, transformOrigin: "center" }, 0.2)

  gsap.timeline({
    defaults: { duration: 0.68, ease: "power3.out" },
    scrollTrigger: { trigger: ".continuity", start: "top 74%", toggleActions: "play none none reverse" },
  })
    .from(".checkpoint", { x: -distance, stagger: 0.1 }, 0)
    .from(".continuity-copy > *", { y: distance, stagger: 0.09 }, 0.16)
    .from(".value-grid article", { y: 16, stagger: 0.1 }, 0.34)

  gsap.timeline({
    defaults: { duration: 0.68, ease: "power3.out" },
    scrollTrigger: { trigger: ".approach", start: "top 74%", toggleActions: "play none none reverse" },
  })
    .from(".approach .center-heading > *", { y: distance, stagger: 0.07 }, 0)
    .from(".steps", { x: -distance }, 0.18)
    .from(".approach-visual", { x: distance, scale: 0.98 }, 0.22)

  gsap.timeline({
    defaults: { duration: 0.66, ease: "power3.out" },
    scrollTrigger: { trigger: ".capabilities", start: "top 76%", toggleActions: "play none none reverse" },
  })
    .from(".capabilities .center-heading", { autoAlpha: 0, y: distance }, 0)
    .from(".capability-grid", { autoAlpha: 0, duration: 0.5 }, 0.12)
    .from(".stats-strip > div", { autoAlpha: 0, y: 14, stagger: 0.07 }, 0.3)

  gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: {
      trigger: ".terminal-section",
      start: context.conditions.desktop ? "top 78%" : "top 84%",
      end: context.conditions.desktop ? "bottom 24%" : "bottom 16%",
      scrub: 0.8,
    },
  })
    .from(".terminal-section .center-heading > *", { autoAlpha: 0, y: distance, stagger: 0.1, duration: 0.7 }, 0)
    .fromTo(".product-shot", { autoAlpha: 0.45, y: 42, scale: 0.9, rotationX: 6 }, { autoAlpha: 1, y: -10, scale: 1, rotationX: 0, duration: 2.1 }, 0.25)
    .from(".product-grid-lines", { autoAlpha: 0, y: 30, scale: 0.92, duration: 1.65 }, 0.38)
    .from(".callout", {
      autoAlpha: 0,
      x: (index) => index < 3 ? -24 : 24,
      stagger: { each: 0.18, from: "edges" },
      duration: 0.72,
    }, 1.05)

  gsap.timeline({
    defaults: { duration: 0.68, ease: "power3.out" },
    scrollTrigger: { trigger: ".install", start: "top 80%", toggleActions: "play none none reverse" },
  }).from(".install-box", { autoAlpha: 0, y: distance, scale: 0.985 })

  gsap.timeline({
    defaults: { duration: 0.62, ease: "power3.out" },
    scrollTrigger: { trigger: ".faq", start: "top 78%", toggleActions: "play none none reverse" },
  })
    .from(".faq .center-heading", { autoAlpha: 0, y: distance }, 0)
    .from(".faq-item", { autoAlpha: 0, x: -14, stagger: 0.055 }, 0.14)

  gsap.timeline({
    defaults: { ease: "none" },
    scrollTrigger: { trigger: ".final-cta", start: "top 84%", end: "center 58%", scrub: 0.7 },
  })
    .from(".cta-rings", { scale: 0.82, rotation: -6, duration: 1 }, 0)
    .from(".final-copy", { y: 20, duration: 0.8 }, 0.12)

  const pointerEvents = new AbortController()
  if (context.conditions.finePointer) {
    const geometry = document.querySelector(".hero-geometry")
    const heroSection = document.querySelector(".hero")
    const productStage = document.querySelector(".product-stage")
    const productShot = document.querySelector(".product-shot")
    const geometryX = gsap.quickTo(geometry, "x", { duration: 0.8, ease: "power3.out" })
    const geometryY = gsap.quickTo(geometry, "y", { duration: 0.8, ease: "power3.out" })
    const shotX = gsap.quickTo(productShot, "x", { duration: 0.72, ease: "power3.out" })
    const shotRotationY = gsap.quickTo(productShot, "rotationY", { duration: 0.72, ease: "power3.out" })

    const moveGeometry = (event) => {
      const bounds = heroSection.getBoundingClientRect()
      geometryX(((event.clientX - bounds.left) / bounds.width - 0.5) * 10)
      geometryY(((event.clientY - bounds.top) / bounds.height - 0.5) * 8)
    }
    const resetGeometry = () => { geometryX(0); geometryY(0) }
    const moveProduct = (event) => {
      const bounds = productStage.getBoundingClientRect()
      shotRotationY(((event.clientX - bounds.left) / bounds.width - 0.5) * 2.4)
      shotX(((event.clientX - bounds.left) / bounds.width - 0.5) * 7)
    }
    const resetProduct = () => { shotX(0); shotRotationY(0) }

    heroSection.addEventListener("pointermove", moveGeometry, { signal: pointerEvents.signal })
    heroSection.addEventListener("pointerleave", resetGeometry, { signal: pointerEvents.signal })
    productStage.addEventListener("pointermove", moveProduct, { signal: pointerEvents.signal })
    productStage.addEventListener("pointerleave", resetProduct, { signal: pointerEvents.signal })
  }

  let active = true
  Promise.allSettled([
    document.fonts.ready,
    ...Array.from(document.images, (image) => image.decode()),
  ]).then(() => { if (active) ScrollTrigger.refresh() })

  return () => {
    active = false
    pointerEvents.abort()
  }
})

import("./details.js")
window.addEventListener("pagehide", () => motion.revert(), { once: true })
