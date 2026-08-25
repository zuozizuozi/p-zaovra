import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { Header } from "~/component/header"
import { LocaleLinks } from "~/component/locale-links"

const email = "support@zaovra.com"

export default function PrivacyPolicy() {
  return (
    <main data-page="legal">
      <Title>Zaovra | Privacy Policy</Title>
      <Meta name="description" content="How Zaovra handles account, billing, desktop, BYOK, and managed model data." />
      <LocaleLinks path="/legal/privacy-policy" />
      <div data-component="container">
        <Header />
        <div data-component="content">
          <section data-component="brand-content">
            <article data-component="privacy-policy">
              <h1>Privacy Policy</h1>
              <p class="effective-date">Effective date: August 25, 2026</p>

              <p>
                This Policy explains how Zaovra handles information when you visit the website, sign in, purchase a
                membership, or use the desktop app. It distinguishes BYOK traffic from Zaovra-managed model access so you
                can understand where your data goes.
              </p>

              <h2>1. Information we collect</h2>
              <ul>
                <li><strong>Account data:</strong> account identifiers, verified email address, sign-in provider, and workspace membership.</li>
                <li><strong>Billing data:</strong> plan, subscription status, transaction identifiers, invoice records, and limited payment-method metadata such as type and last four digits. Stripe handles full payment credentials.</li>
                <li><strong>Service data:</strong> app version, device and network diagnostics, feature usage, model and token usage, errors, and security events.</li>
                <li><strong>Support data:</strong> messages and files you choose to send when requesting help.</li>
                <li><strong>AI request data:</strong> prompts, relevant workspace context, tool results, and model output when needed to perform a request.</li>
              </ul>

              <h2>2. BYOK data flow</h2>
              <p>
                BYOK credentials are configured in the desktop app and are not entered on the Zaovra website. BYOK model
                requests are sent using the provider connection you choose and are subject to that provider’s privacy
                and retention terms. A Zaovra account is still required to use the desktop app, but BYOK does not require
                a paid membership or consume managed model allowance.
              </p>

              <h2>3. Managed model data flow</h2>
              <p>
                When you use a paid membership’s managed model access, Zaovra processes and routes the request to the
                model provider selected by the live service configuration. Request content is transmitted only as needed
                to return the requested result. We also record operational and usage metadata needed to apply your plan,
                prevent abuse, diagnose failures, and maintain billing records. Upstream providers may process request
                content under their applicable data terms.
              </p>

              <h2>4. How we use information</h2>
              <p>
                We use information to authenticate accounts, operate desktop and managed model features, process and
                reconcile subscriptions, provide support, secure the Service, prevent fraud and abuse, diagnose errors,
                meet legal obligations, and communicate material service or policy changes. We do not sell personal
                information. We do not use private source code or prompt content to train public AI models without your
                explicit consent.
              </p>

              <h2>5. Service providers</h2>
              <p>
                We disclose only the information necessary to providers that support authentication, payment processing,
                infrastructure, monitoring, support, and managed AI inference. Stripe processes payments. GitHub or Google
                processes sign-in when you choose that provider. Each provider processes data under its own terms and our
                applicable agreement with it.
              </p>

              <h2>6. Retention</h2>
              <p>
                Account and subscription records are retained while your account is active and as needed for security,
                dispute resolution, tax, accounting, and legal obligations. Operational logs are retained only for the
                period needed for reliability and security. Support messages are retained while the request is active and
                for a reasonable follow-up period. Provider-side retention for BYOK and managed inference is governed by
                the provider terms applicable to that request.
              </p>

              <h2>7. Security</h2>
              <p>
                We use access controls, encrypted transport, environment-separated credentials, and restricted internal
                access appropriate to the information processed. No system is completely secure; please report suspected
                account or credential compromise promptly.
              </p>

              <h2>8. Your choices and rights</h2>
              <p>
                You may request access, correction, export, or deletion of personal information, subject to identity
                verification and legal retention duties. You may cancel a membership through the billing portal and may
                stop provider processing by removing a BYOK connection from the desktop app.
              </p>

              <h2>9. Children</h2>
              <p>The Service is not directed to children under 13, and we do not knowingly collect their personal information.</p>

              <h2>10. Policy changes</h2>
              <p>Material changes will be announced through the website, account, or email before they take effect where required.</p>

              <h2>11. Contact</h2>
              <p>Privacy, account, and data-rights requests: <a href={`mailto:${email}`}>{email}</a>.</p>
            </article>
          </section>
        </div>
      </div>
    </main>
  )
}
