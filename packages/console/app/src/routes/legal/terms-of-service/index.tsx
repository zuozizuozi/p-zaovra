import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { Header } from "~/component/header"
import { LocaleLinks } from "~/component/locale-links"

const email = "support@zaovra.com"

export default function TermsOfService() {
  return (
    <main data-page="legal">
      <Title>Zaovra | Terms of Service</Title>
      <Meta name="description" content="Terms governing use of the Zaovra website, account, memberships, and desktop app." />
      <LocaleLinks path="/legal/terms-of-service" />
      <div data-component="container">
        <Header />
        <div data-component="content">
          <section data-component="brand-content">
            <article data-component="terms-of-service">
              <h1>Terms of Service</h1>
              <p class="effective-date">Effective date: August 25, 2026</p>

              <p>
                These Terms govern your use of the Zaovra website, account services, paid memberships, managed model
                access, and desktop application (together, the “Service”). By creating an account, purchasing a
                membership, downloading the app, or using the Service, you agree to these Terms.
              </p>

              <h2>1. The Service</h2>
              <p>
                Zaovra is a desktop coding agent that can inspect workspace context, propose and apply file changes,
                execute approved commands, and present results for review. AI output can be inaccurate or unsafe. You
                are responsible for reviewing changes, commands, credentials, and output before relying on them.
              </p>

              <h2>2. Accounts</h2>
              <p>
                A Zaovra account is required to use the desktop app, including when you connect your own model provider
                credentials. You must provide accurate account information, keep access to your sign-in provider secure,
                and promptly notify us if you believe your account has been compromised.
              </p>

              <h2>3. BYOK</h2>
              <p>
                Bring Your Own Key (“BYOK”) does not require a paid Zaovra membership. Provider credentials are
                configured in the desktop app. Your use of a third-party model provider remains subject to that
                provider’s terms, billing, availability, and data practices. Zaovra is not responsible for charges or
                service decisions made by a provider you connect directly.
              </p>

              <h2>4. Memberships and managed model access</h2>
              <p>
                Zaovra plans to offer Starter, Pro, and Max monthly memberships. Until checkout is explicitly opened on
                the pricing page, the displayed plans are informational only, no payment is collected, and no managed
                model entitlement is created. When purchasing becomes available, the current price, included allowance,
                model availability, and renewal terms will be shown before payment.
              </p>

              <h2>5. Billing, renewal, cancellation, and refunds</h2>
              <p>
                No payment is collected while checkout is marked as unavailable. When purchasing becomes available,
                the payment processor, renewal and cancellation timing, refund handling, and any statutory cancellation
                rights will be shown in the applicable purchase terms before payment.
              </p>

              <h2>6. Acceptable use</h2>
              <p>
                You may not use the Service to violate law, infringe rights, distribute malware, bypass access controls,
                interfere with the Service, probe another user’s data, resell account access without permission, or use
                automated means to abuse usage limits. We may suspend access when reasonably necessary to protect users,
                providers, or the Service.
              </p>

              <h2>7. Your content and responsibility</h2>
              <p>
                You retain your rights in the code, prompts, files, and other material you provide. You grant Zaovra the
                limited right to process that material only as needed to operate, secure, and support the Service. You
                are responsible for having permission to submit the material and for maintaining backups of important
                work.
              </p>

              <h2>8. Availability and changes</h2>
              <p>
                Preview features may change or be withdrawn before general release. We may update the Service and these
                Terms. Material changes will be communicated through the website, account, or email and will apply
                prospectively from the stated effective date.
              </p>

              <h2>9. Warranty and liability</h2>
              <p>
                The Service is provided on an “as available” basis to the extent permitted by law. We do not guarantee
                uninterrupted operation or error-free AI output. To the maximum extent permitted by law, Zaovra is not
                liable for indirect, incidental, special, consequential, or lost-profit damages. Nothing in these Terms
                excludes rights or liability that cannot legally be excluded.
              </p>

              <h2>10. Contact</h2>
              <p>Questions about these Terms, billing, or account access: <a href={`mailto:${email}`}>{email}</a>.</p>
            </article>
          </section>
        </div>
      </div>
    </main>
  )
}
