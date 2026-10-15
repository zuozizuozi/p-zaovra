import "./home.css"
import { Meta, Title } from "@solidjs/meta"
import { A } from "@solidjs/router"
import { For } from "solid-js"
import idle from "../asset/mascot/idle-128.webp"
import thinking from "../asset/mascot/thinking-128.webp"
import awaiting from "../asset/mascot/awaiting-128.webp"
import failed from "../asset/mascot/error-128.webp"
import success from "../asset/mascot/success-128.webp"
import successLarge from "../asset/mascot/success-512.webp"
import { SiteFooter, SiteHeader } from "~/component/site-chrome"
import { LocaleLinks } from "~/component/locale-links"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"

const models = ["Anthropic Claude", "OpenAI GPT", "Google Gemini", "DeepSeek", "OpenRouter", "GitHub Copilot"]

const mascots = [
  { src: idle, label: "home.v3.mascot.idle" },
  { src: thinking, label: "home.v3.mascot.thinking" },
  { src: awaiting, label: "home.v3.mascot.awaiting" },
  { src: failed, label: "home.v3.mascot.error" },
  { src: success, label: "home.v3.mascot.success" },
] as const

const checks = [
  ["test", "bun test"],
  ["types", "bun typecheck"],
  ["lint", "bun lint"],
  ["build", "bun run build"],
] as const

const faqs = [
  ["home.next.faq.account.q", "home.next.faq.account.a"],
  ["home.next.faq.local.q", "home.next.faq.local.a"],
  ["home.next.faq.desktop.q", "home.next.faq.desktop.a"],
  ["home.next.faq.workgraph.q", "home.next.faq.workgraph.a"],
] as const

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8h9.5M8.5 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}

export default function Home() {
  const i18n = useI18n()
  const language = useLanguage()

  return (
    <main data-page="home" data-skin="zaovra">
      <Title>{i18n.t("home.next.metaTitle")}</Title>
      <Meta name="description" content={i18n.t("home.next.metaDescription")} />
      <Meta property="og:image" content="/social-share.png" />
      <Meta name="twitter:image" content="/social-share.png" />
      <LocaleLinks path="/" />

      <SiteHeader />

      <section data-component="hero">
        <div data-slot="glow" aria-hidden="true" />
        <div data-slot="grid" aria-hidden="true" />
        <div data-slot="copy">
          <A href={language.route("/download")} data-slot="badge">
            <span data-slot="pulse" />
            {i18n.t("home.v3.hero.badge")}
            <Arrow />
          </A>
          <h1>
            <span>{i18n.t("home.v3.hero.title1")}</span>
            <span data-slot="accent">{i18n.t("home.v3.hero.title2")}</span>
          </h1>
          <p>{i18n.t("home.v3.hero.body")}</p>
          <div data-slot="actions">
            <A href={language.route("/download")} data-variant="primary">
              {i18n.t("home.next.action.downloadBeta")}
              <Arrow />
            </A>
            <A href={language.route("/docs")} data-variant="secondary">
              {i18n.t("home.v3.hero.docs")}
            </A>
          </div>
          <small>{i18n.t("home.v3.hero.note")}</small>
        </div>

        <figure data-component="app-mock" id="product" role="img" aria-label={i18n.t("home.v3.mock.ariaLabel")}>
          <div data-slot="titlebar" aria-hidden="true">
            <span data-slot="lights">
              <i />
              <i />
              <i />
            </span>
            <span data-slot="title">
              <img src={idle} alt="" width="16" height="16" />
              Zaovra
            </span>
            <span data-slot="tabs">
              <b>{i18n.t("home.v3.mock.review")}</b>
              <b data-active>{i18n.t("home.v3.mock.output")}</b>
            </span>
          </div>
          <div data-slot="body" aria-hidden="true">
            <aside data-slot="sidebar">
              <span data-slot="new">＋ {i18n.t("home.v3.mock.newChat")}</span>
              <span data-slot="label">{i18n.t("home.v3.mock.projects")}</span>
              <span data-slot="project">shop-api</span>
              <span data-slot="session" data-active>
                {i18n.t("home.v3.mock.session1")}
              </span>
              <span data-slot="session">{i18n.t("home.v3.mock.session2")}</span>
              <span data-slot="session">{i18n.t("home.v3.mock.session3")}</span>
              <span data-slot="spacer" />
              <span data-slot="foot">{i18n.t("home.v3.mock.settings")}</span>
              <span data-slot="foot">{i18n.t("home.v3.mock.help")}</span>
            </aside>

            <div data-slot="chat">
              <div data-slot="chat-title">{i18n.t("home.v3.mock.session1")}</div>
              <div data-slot="bubble">{i18n.t("home.v3.mock.prompt")}</div>
              <div data-slot="agent">
                <span data-slot="avatar">
                  <img data-state="thinking" src={thinking} alt="" width="22" height="22" />
                  <img data-state="success" src={success} alt="" width="22" height="22" />
                </span>
                <strong>Zaovra</strong>
                <span data-slot="state">
                  <em data-state="thinking">{i18n.t("home.v3.mock.thinking")}</em>
                  <em data-state="success">{i18n.t("home.v3.mock.done")}</em>
                </span>
              </div>
              <ol data-slot="steps">
                <li style="--i:0">
                  <Check /> {i18n.t("home.v3.mock.read")}
                </li>
                <li style="--i:1">
                  <Check /> {i18n.t("home.v3.mock.edit")} <code>src/export/csv.ts</code>
                  <span data-slot="add">+48</span>
                  <span data-slot="del">−2</span>
                </li>
                <li style="--i:2">
                  <Check /> {i18n.t("home.v3.mock.edit")} <code>test/export.test.ts</code>
                  <span data-slot="add">+31</span>
                </li>
                <li style="--i:3">
                  <Check /> {i18n.t("home.v3.mock.run")} <code>bun test</code>
                  <span data-slot="exit">exit 0</span>
                </li>
              </ol>
              <p data-slot="reply">{i18n.t("home.v3.mock.reply")}</p>
              <div data-slot="verify">
                <strong>{i18n.t("home.v3.mock.verify")}</strong>
                <For each={checks.slice(0, 3)}>
                  {(row) => (
                    <span>
                      {i18n.t("home.v3.mock.passed")} · {row[0]} <code>{row[1]}</code>
                      <b>exit 0</b>
                    </span>
                  )}
                </For>
              </div>
              <div data-slot="composer">
                <span>{i18n.t("home.v3.mock.composer")}</span>
                <div>
                  <b>＋</b>
                  <em>{i18n.t("home.v3.mock.model")}</em>
                  <em>Medium</em>
                  <i>↑</i>
                </div>
              </div>
              <div data-slot="usage">{i18n.t("home.v3.mock.usage")}</div>
            </div>

            <div data-slot="panel">
              <div data-slot="file">src/export/csv.ts</div>
              <pre data-slot="diff">
                <span data-kind="ctx">
                  <i>12</i>export function toRows(orders: Order[]) {"{"}
                </span>
                <span data-kind="del">
                  <i>13</i>- return orders.map(toJson)
                </span>
                <span data-kind="add">
                  <i>13</i>+ const header = COLUMNS.map(escape)
                </span>
                <span data-kind="add">
                  <i>14</i>+ const body = orders.map(toLine)
                </span>
                <span data-kind="add">
                  <i>15</i>+ return [header, ...body].join("\n")
                </span>
                <span data-kind="ctx">
                  <i>16</i>
                  {"}"}
                </span>
                <span data-kind="ctx">
                  <i>17</i>
                </span>
                <span data-kind="add">
                  <i>18</i>+ function escape(value: string) {"{"}
                </span>
                <span data-kind="add">
                  <i>19</i>+ if (!/[",\n]/.test(value)) return value
                </span>
                <span data-kind="add">
                  <i>20</i>+ return `"${"{"}value.replaceAll('"', '""'){"}"}"`
                </span>
                <span data-kind="add">
                  <i>21</i>+ {"}"}
                </span>
              </pre>
              <div data-slot="terminal">
                <span>
                  <b>$</b> bun test
                </span>
                <span data-tone="dim">test/export.test.ts</span>
                <span data-tone="ok">✓ 18 pass</span>
                <span data-tone="dim">0 fail · 41 expect() calls</span>
                <span data-tone="dim">Ran 18 tests across 3 files. [612ms]</span>
              </div>
            </div>
          </div>
        </figure>
      </section>

      <section data-component="models" aria-label={i18n.t("home.v3.models.title")}>
        <p>{i18n.t("home.v3.models.title")}</p>
        <ul>
          <For each={models}>{(name) => <li>{name}</li>}</For>
          <li data-variant="custom">{i18n.t("home.v3.models.custom")}</li>
        </ul>
      </section>

      <section data-component="showcase">
        <div data-slot="copy">
          <span data-slot="kicker">{i18n.t("home.v3.permission.kicker")}</span>
          <h2>{i18n.t("home.v3.permission.title")}</h2>
          <p>{i18n.t("home.v3.permission.body")}</p>
          <ul>
            <li>
              <Check /> {i18n.t("home.v3.permission.point1")}
            </li>
            <li>
              <Check /> {i18n.t("home.v3.permission.point2")}
            </li>
            <li>
              <Check /> {i18n.t("home.v3.permission.point3")}
            </li>
          </ul>
        </div>
        <div data-slot="stage" aria-hidden="true">
          <div data-component="permission-card">
            <header>
              <span data-slot="warn">!</span>
              {i18n.t("home.v3.permission.cardTitle")}
            </header>
            <strong>bash</strong>
            <span>{i18n.t("home.v3.permission.cardAction")}</span>
            <code>bun run migrate --env staging</code>
            <p>{i18n.t("home.v3.permission.cardBody")}</p>
            <footer>
              <b>{i18n.t("home.v3.permission.deny")}</b>
              <b data-variant="outline">{i18n.t("home.v3.permission.always")}</b>
              <b data-variant="solid">{i18n.t("home.v3.permission.once")}</b>
            </footer>
          </div>
          <img data-slot="mascot" src={awaiting} alt="" width="96" height="96" />
        </div>
      </section>

      <section data-component="showcase" data-reverse>
        <div data-slot="copy">
          <span data-slot="kicker">{i18n.t("home.v3.verify.kicker")}</span>
          <h2>{i18n.t("home.v3.verify.title")}</h2>
          <p>{i18n.t("home.v3.verify.body")}</p>
          <ul>
            <li>
              <Check /> {i18n.t("home.v3.verify.point1")}
            </li>
            <li>
              <Check /> {i18n.t("home.v3.verify.point2")}
            </li>
            <li>
              <Check /> {i18n.t("home.v3.verify.point3")}
            </li>
          </ul>
        </div>
        <div data-slot="stage" aria-hidden="true">
          <div data-component="verify-card">
            <span data-slot="muted">{i18n.t("home.v3.verify.end")}</span>
            <strong>{i18n.t("home.v3.verify.summary")}</strong>
            <span data-slot="muted">▾ {i18n.t("home.v3.verify.current")}</span>
            <ul>
              <For each={checks}>
                {(row, index) => (
                  <li style={`--i:${index()}`}>
                    <Check />
                    <span>
                      {i18n.t("home.v3.mock.passed")} · {row[0]}
                    </span>
                    <code>{row[1]}</code>
                    <b>exit 0</b>
                  </li>
                )}
              </For>
            </ul>
            <span data-slot="link">{i18n.t("home.v3.verify.refresh")}</span>
          </div>
          <img data-slot="mascot" src={success} alt="" width="96" height="96" />
        </div>
      </section>

      <section data-component="showcase">
        <div data-slot="copy">
          <span data-slot="kicker">{i18n.t("home.v3.output.kicker")}</span>
          <h2>{i18n.t("home.v3.output.title")}</h2>
          <p>{i18n.t("home.v3.output.body")}</p>
          <ul>
            <li>
              <Check /> {i18n.t("home.v3.output.point1")}
            </li>
            <li>
              <Check /> {i18n.t("home.v3.output.point2")}
            </li>
          </ul>
        </div>
        <div data-slot="stage" aria-hidden="true">
          <div data-component="output-card">
            <header>
              <b>{i18n.t("home.v3.mock.review")}</b>
              <b data-active>{i18n.t("home.v3.mock.output")}</b>
            </header>
            <div data-slot="url">
              <span>http://127.0.0.1:5173</span>
              <b>{i18n.t("home.v3.output.open")}</b>
            </div>
            <div data-slot="preview">
              <div data-slot="site-nav">
                <i />
                <span />
                <span />
                <span />
              </div>
              <div data-slot="site-hero">
                <span />
                <span />
                <b />
              </div>
              <div data-slot="site-cards">
                <i />
                <i />
                <i />
              </div>
            </div>
            <div data-slot="files">
              <strong>{i18n.t("home.v3.output.files")}</strong>
              <span>index.html</span>
              <span>report.pdf</span>
              <span>chart.png</span>
            </div>
          </div>
        </div>
      </section>

      <section data-component="bento">
        <div data-slot="heading">
          <span data-slot="kicker">{i18n.t("home.v3.bento.kicker")}</span>
          <h2>{i18n.t("home.v3.bento.title")}</h2>
        </div>
        <div data-slot="grid">
          <article data-slot="mascots">
            <h3>{i18n.t("home.v3.mascot.title")}</h3>
            <p>{i18n.t("home.v3.mascot.body")}</p>
            <ul aria-hidden="true">
              <For each={mascots}>
                {(item) => (
                  <li>
                    <img src={item.src} alt="" width="64" height="64" />
                    <span>{i18n.t(item.label)}</span>
                  </li>
                )}
              </For>
            </ul>
          </article>
          <article data-slot="usage">
            <h3>{i18n.t("home.v3.usage.title")}</h3>
            <p>{i18n.t("home.v3.usage.body")}</p>
            <div aria-hidden="true">
              <span>{i18n.t("home.v3.usage.total")}</span>
              <strong>615,051</strong>
              <i>
                <b />
              </i>
              <span>{i18n.t("home.v3.usage.last")} · 136,828</span>
            </div>
          </article>
          <article data-slot="sessions">
            <h3>{i18n.t("home.v3.sessions.title")}</h3>
            <p>{i18n.t("home.v3.sessions.body")}</p>
            <div aria-hidden="true">
              <span data-active>{i18n.t("home.v3.mock.session1")}</span>
              <span>{i18n.t("home.v3.mock.session2")}</span>
              <span>{i18n.t("home.v3.mock.session3")}</span>
            </div>
          </article>
          <article data-slot="endpoint">
            <h3>{i18n.t("home.v3.endpoint.title")}</h3>
            <p>{i18n.t("home.v3.endpoint.body")}</p>
            <div aria-hidden="true">
              <span>
                <b>Chat</b> /chat/completions
              </span>
              <span>
                <b>Responses</b> /responses
              </span>
            </div>
          </article>
        </div>
      </section>

      <section data-component="access">
        <div data-slot="heading">
          <span data-slot="kicker">{i18n.t("home.v3.access.kicker")}</span>
          <h2>{i18n.t("home.v3.access.title")}</h2>
        </div>
        <div data-slot="cards">
          <article data-variant="featured">
            <span data-slot="tag">{i18n.t("home.v3.access.byok.tag")}</span>
            <h3>{i18n.t("home.v3.access.byok.title")}</h3>
            <p>{i18n.t("home.v3.access.byok.body")}</p>
            <A href={language.route("/docs/providers/")}>
              {i18n.t("home.v3.access.providers")} <Arrow />
            </A>
          </article>
          <article>
            <span data-slot="tag">{i18n.t("home.v3.access.managed.tag")}</span>
            <h3>{i18n.t("home.v3.access.managed.title")}</h3>
            <p>{i18n.t("home.v3.access.managed.body")}</p>
            <A href={language.route("/pricing")}>
              {i18n.t("home.v3.access.pricing")} <Arrow />
            </A>
          </article>
        </div>
        <small>{i18n.t("home.v3.access.note")}</small>
      </section>

      <section data-component="faq">
        <div data-slot="heading">
          <span data-slot="kicker">FAQ</span>
          <h2>{i18n.t("home.next.faq.title")}</h2>
        </div>
        <div data-slot="list">
          <For each={faqs}>
            {(item) => (
              <details>
                <summary>{i18n.t(item[0])}</summary>
                <p>{i18n.t(item[1])}</p>
              </details>
            )}
          </For>
        </div>
      </section>

      <section data-component="cta">
        <div data-slot="glow" aria-hidden="true" />
        <img src={successLarge} alt="" width="176" height="176" />
        <h2>{i18n.t("home.v3.cta.title")}</h2>
        <p>{i18n.t("home.v3.cta.body")}</p>
        <div data-slot="actions">
          <A href={language.route("/download")} data-variant="primary">
            {i18n.t("home.next.action.downloadBeta")}
            <Arrow />
          </A>
          <A href={language.route("/docs")} data-variant="secondary">
            {i18n.t("home.v3.hero.docs")}
          </A>
        </div>
      </section>

      <SiteFooter />
    </main>
  )
}
