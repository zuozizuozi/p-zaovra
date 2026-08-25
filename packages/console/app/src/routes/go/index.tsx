import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { For } from "solid-js"
import { Footer } from "~/component/footer"
import { Header } from "~/component/header"
import { Legal } from "~/component/legal"
import { LocaleLinks } from "~/component/locale-links"

const plans = [
  {
    id: "20",
    name: "Starter",
    summary: "For individual developers who want managed model access alongside BYOK.",
  },
  {
    id: "100",
    name: "Pro",
    summary: "For regular agent workflows and a larger managed model allowance.",
    featured: true,
  },
  {
    id: "200",
    name: "Max",
    summary: "For sustained desktop agent work with the highest managed allowance.",
  },
] as const

export default function Pricing() {
  return (
    <main data-page="pricing">
      <Title>Zaovra pricing</Title>
      <Meta
        name="description"
        content="Use Zaovra with your own model keys, or choose a membership for managed model access."
      />
      <LocaleLinks path="/pricing" />

      <div data-component="pricing-shell">
        <Header hideGetStarted />
        <section data-component="pricing-hero">
          <span data-slot="eyebrow">SIMPLE ACCESS</span>
          <h1>Bring your keys, or use ours.</h1>
          <p>
            Every desktop session requires a Zaovra account. BYOK does not require a paid membership. Managed model
            memberships are shown for reference while checkout is being prepared.
          </p>
        </section>

        <aside data-component="checkout-status" role="status">
          Membership checkout is not open yet. No payment will be collected on this website during the preview period.
        </aside>

        <section data-component="plan-grid" aria-label="Zaovra membership plans">
          <For each={plans}>
            {(plan) => (
              <article
                data-component="plan-card"
                data-featured={"featured" in plan && plan.featured ? "" : undefined}
              >
                <div>
                  <span data-slot="plan-name">{plan.name}</span>
                  <p data-slot="price"><strong>${plan.id}</strong><span>/ month</span></p>
                  <p data-slot="summary">{plan.summary}</p>
                </div>
                <ul>
                  <li>Zaovra desktop coding agent</li>
                  <li>BYOK remains available</li>
                  <li>Managed model access for this tier</li>
                  <li>Cancel from the billing portal</li>
                </ul>
                <button type="button" disabled>Checkout coming soon</button>
              </article>
            )}
          </For>
        </section>

        <section data-component="pricing-notes">
          <div>
            <h2>BYOK</h2>
            <p>Connect provider credentials inside the desktop app. No membership purchase is required.</p>
          </div>
          <div>
            <h2>Managed access</h2>
            <p>Model availability and usage allowances are shown from the live service configuration, not promised here.</p>
          </div>
          <div>
            <h2>Account required</h2>
            <p>You must sign in to Zaovra before using the desktop app, including when using BYOK.</p>
          </div>
        </section>

        <Footer />
      </div>
      <Legal />
    </main>
  )
}
