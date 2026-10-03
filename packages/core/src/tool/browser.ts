export * as BrowserTool from "./browser"

import { Context, Effect, Layer, Schema } from "effect"
import type { Browser, Page, Locator } from "playwright-core"
import { makeLocationNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { PermissionV2 } from "../permission"
import { Catalog } from "../catalog"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { BrowserSession } from "./browser-session"

const Target = Schema.Union([
  Schema.Struct({
    role: Schema.Literals(["button", "link", "textbox", "checkbox", "combobox", "radio", "menuitem", "tab"]),
    name: Schema.String,
  }),
  Schema.Struct({ label: Schema.String }),
  Schema.Struct({ selector: Schema.String }),
])
const Input = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("open"),
    url: Schema.String,
    allowOrigins: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({ action: Schema.Literal("click"), target: Target }),
  Schema.Struct({ action: Schema.Literal("click_position"), x: Schema.Number, y: Schema.Number }),
  Schema.Struct({ action: Schema.Literal("type"), target: Target, text: Schema.String }),
  Schema.Struct({
    action: Schema.Literal("press"),
    key: Schema.String,
    holdMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3000 }))),
  }),
  Schema.Struct({
    action: Schema.Literal("scroll"),
    x: Schema.Number.check(Schema.isBetween({ minimum: -2000, maximum: 2000 })),
    y: Schema.Number.check(Schema.isBetween({ minimum: -2000, maximum: 2000 })),
  }),
  Schema.Struct({ action: Schema.Literals(["snapshot", "screenshot", "console", "close"]) }),
])
const Output = Schema.Struct({
  text: Schema.String,
  screenshot: Schema.optional(
    Schema.Struct({
      data: Schema.String,
      mime: Schema.Literal("image/png"),
      name: Schema.String,
      modelVisible: Schema.Boolean,
    }),
  ),
})

// A test seam for the resource timer, not a provider retry or execution budget.
export const IdleTimeout = Context.Reference<number>("@zaovra/BrowserIdleTimeout", { defaultValue: () => 600_000 })
export const Service = BrowserSession.Service

type Owned = {
  browser: Browser
  page: Page
  origins: Set<string>
  logs: string[]
  timer?: ReturnType<typeof setTimeout>
}

function origin(value: string) {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Only HTTP(S) origins without credentials are allowed")
  return url.origin
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    if (process.platform === "win32" && process.versions.bun) return Service.of({ close: () => Effect.void })
    const tools = yield* Tools.Service
    const permissions = yield* PermissionV2.Service
    const catalog = yield* Catalog.Service
    const sessions = yield* SessionStore.Service
    const outputs = yield* ToolOutputStore.Service
    const idle = yield* IdleTimeout
    const owned = new Map<SessionSchema.ID, Owned>()
    const locks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
    const close = async (id: SessionSchema.ID) => {
      const current = owned.get(id)
      if (!current) return
      owned.delete(id)
      clearTimeout(current.timer)
      await current.browser.close().catch(() => {})
    }
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.all([...owned.keys()].map(close))).pipe(Effect.asVoid),
    )

    yield* tools
      .register({
        browser: Tool.make({
          description:
            "Use this tool to observe and interact with local web previews instead of writing browser scripts. Run repeatable assertions with bash and the project's tests; screenshots do not prove completion. Open an authorized local URL first; use observed unique roles/labels/selectors or screenshot coordinates. Explicitly authorize any additional resource origins with allowOrigins on open. No uploads, downloads, or arbitrary JavaScript.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            { type: "text", text: output.text },
            ...(output.screenshot?.modelVisible
              ? [
                  {
                    type: "file" as const,
                    data: output.screenshot.data,
                    mime: output.screenshot.mime,
                    name: output.screenshot.name,
                  },
                ]
              : []),
          ],
          execute: (input, context) =>
            locks.withLock(context.sessionID)(
              Effect.gen(function* () {
                if (input.action === "close") {
                  yield* Effect.promise(() => close(context.sessionID))
                  return { text: "Browser closed. Preview server was not stopped." }
                }
                const requested = yield* Effect.try({
                  try: () => {
                    if (input.action !== "open") return []
                    const url = new URL(input.url)
                    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
                      throw new Error("open requires a localhost, 127.0.0.1, or [::1] preview URL")
                    return [...new Set([origin(input.url), ...(input.allowOrigins ?? []).map(origin)])]
                  },
                  catch: (error) =>
                    new Tool.Failure({ message: `Not executed: ${String(error)}`, metadata: { phase: "input" } }),
                })
                const previous = owned.get(context.sessionID)
                if (input.action !== "open" && !previous)
                  return yield* new Tool.Failure({
                    message:
                      "Not executed: no active browser (closed, idle timeout, or lost process). Explicitly open a new page.",
                  })
                yield* permissions
                  .assert({
                    action: "browser",
                    resources: requested.length ? requested : [...previous!.origins],
                    save: requested.length ? requested : [...previous!.origins],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                  .pipe(
                    Effect.mapError(
                      () => new Tool.Failure({ message: "Not executed: browser origin permission denied" }),
                    ),
                  )
                if (previous) clearTimeout(previous.timer)
                let started = false
                const result = yield* Effect.tryPromise({
                  try: async (signal) => {
                    const abort = () => {
                      void close(context.sessionID)
                    }
                    signal.addEventListener("abort", abort, { once: true })
                    try {
                      let current = owned.get(context.sessionID)
                      if (current && !current.browser.isConnected()) {
                        await close(context.sessionID)
                        current = undefined
                      }
                      if (!current) {
                        if (input.action !== "open") throw new Error("Browser process lost; explicitly open a new page")
                        if (process.platform === "win32" && process.versions.bun)
                          throw new Error(
                            "Browser previews require the Desktop Node runtime on Windows; Bun browser pipes are not supported",
                          )
                        const { chromium } = await import("playwright-core")
                        const browser = await chromium
                          .launch({ headless: true, chromiumSandbox: true, timeout: 10000 })
                          .catch(async (error: Error) => {
                            if (!error.message.includes("Executable doesn't exist")) throw error
                            return chromium
                              .launch({ channel: "chrome", headless: true, chromiumSandbox: true, timeout: 10000 })
                              .catch(() =>
                                chromium.launch({
                                  channel: "msedge",
                                  headless: true,
                                  chromiumSandbox: true,
                                  timeout: 10000,
                                }),
                              )
                              .catch(() => {
                                throw new Error(
                                  "No compatible Chromium found. Install Playwright Chromium or Chrome/Edge outside the agent run, then open again.",
                                )
                              })
                          })
                        if (signal.aborted) {
                          await browser.close()
                          throw new Error("Cancelled")
                        }
                        try {
                          const browserContext = await browser.newContext({
                            viewport: { width: 1280, height: 720 },
                            acceptDownloads: false,
                            serviceWorkers: "block",
                            permissions: [],
                          })
                          const page = await browserContext.newPage()
                          current = { browser, page, origins: new Set(requested), logs: [] }
                          const state = current
                          const log = (text: string) => {
                            state.logs.push(text.slice(0, 1000))
                            if (state.logs.length > 100) {
                              state.logs.shift()
                              state.logs[0] = "[Earlier logs dropped: capture limit]"
                            }
                          }
                          await browserContext.route("**/*", async (route) => {
                            const url = new URL(route.request().url())
                            if (!["http:", "https:"].includes(url.protocol) || !state.origins.has(url.origin)) {
                              log(`Blocked origin: ${url.origin}`)
                              return route.abort("blockedbyclient").catch(() => {})
                            }
                            // Playwright does not route redirected requests again. Never let a
                            // permitted URL redirect past the origin permission check.
                            const response = await route
                              .fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10000 })
                              .catch((error: Error) => {
                                log(`Request failed; effects may be partial, no retry: ${error.message}`)
                              })
                            if (!response) return route.abort("failed").catch(() => {})
                            if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
                              log(
                                `Redirect blocked; explicitly open and authorize the destination: ${response.headers().location}`,
                              )
                              await response.dispose()
                              return route
                                .fulfill({
                                  status: 409,
                                  contentType: "text/plain",
                                  body: "Redirect blocked. Explicitly open the destination after authorization.",
                                })
                                .catch(() => {})
                            }
                            await route.fulfill({ response }).catch((error: Error) => {
                              log(`Response delivery failed; no retry: ${error.message}`)
                            })
                            await response.dispose()
                          })
                          await browserContext.routeWebSocket("**/*", (ws) => {
                            const url = new URL(ws.url())
                            url.protocol = url.protocol === "wss:" ? "https:" : "http:"
                            if (state.origins.has(url.origin)) {
                              ws.connectToServer()
                              return
                            }
                            log(`Blocked WebSocket origin: ${url.origin}`)
                            ws.close()
                          })
                          browserContext.on("page", (popup) => {
                            log("Popup blocked")
                            void popup.close().catch(() => {})
                          })
                          page.on("console", (message) => log(`${message.type()}: ${message.text()}`))
                          page.on("pageerror", (error) => log(`pageerror: ${error.message}`))
                          page.on("download", (download) => {
                            log("Download blocked")
                            void download.cancel().catch(() => {})
                          })
                          page.on("filechooser", () => log("File upload blocked"))
                          page.setDefaultTimeout(8000)
                          page.setDefaultNavigationTimeout(10000)
                          owned.set(context.sessionID, current)
                          if (signal.aborted) {
                            await close(context.sessionID)
                            throw new Error("Cancelled")
                          }
                          browser.on("disconnected", () => {
                            if (owned.get(context.sessionID) === state) {
                              clearTimeout(state.timer)
                              owned.delete(context.sessionID)
                            }
                          })
                        } catch (error) {
                          await browser.close().catch(() => {})
                          throw error
                        }
                      }
                      if (signal.aborted) throw new Error("Cancelled")
                      const page = current.page
                      const locate = async (target: typeof Target.Type): Promise<Locator> => {
                        const locator =
                          "role" in target
                            ? page.getByRole(target.role, { name: target.name, exact: true })
                            : "label" in target
                              ? page.getByLabel(target.label, { exact: true })
                              : page.locator(target.selector)
                        const count = await locator.count()
                        if (count !== 1)
                          throw new Error(`Locator matched ${count} elements; observe and choose a unique target`)
                        if ((await locator.getAttribute("type")) === "file")
                          throw new Error("File upload is not supported")
                        return locator
                      }
                      if (input.action === "open") {
                        requested.forEach((value) => current!.origins.add(value))
                        started = true
                        await page.goto(input.url, { waitUntil: "domcontentloaded" })
                      }
                      if (input.action === "click" || input.action === "type") {
                        const locator = await locate(input.target)
                        started = true
                        if (input.action === "click") await locator.click()
                        if (input.action === "type") await locator.fill(input.text)
                      }
                      if (input.action === "click_position") {
                        if (
                          !Number.isFinite(input.x) ||
                          !Number.isFinite(input.y) ||
                          input.x < 0 ||
                          input.x >= 1280 ||
                          input.y < 0 ||
                          input.y >= 720
                        )
                          throw new Error("Coordinates must be within the observed 1280x720 viewport")
                        started = true
                        await page.mouse.click(input.x, input.y)
                      }
                      if (input.action === "press") {
                        started = true
                        if (input.holdMs) {
                          await page.keyboard.down(input.key)
                          try {
                            await new Promise((resolve) => setTimeout(resolve, input.holdMs))
                          } finally {
                            await page.keyboard.up(input.key).catch(() => {})
                          }
                        } else await page.keyboard.press(input.key)
                      }
                      if (input.action === "scroll") {
                        started = true
                        await page.mouse.wheel(input.x, input.y)
                      }
                      const snapshot =
                        input.action === "console"
                          ? ""
                          : (await page.locator("body").ariaSnapshot({ timeout: 8000 })).slice(0, 24000)
                      const logs = current.logs.splice(0)
                      const screenshot =
                        input.action === "screenshot"
                          ? await page.screenshot({ type: "png", fullPage: false, timeout: 8000 })
                          : undefined
                      return {
                        text: `URL: ${page.url()}\nTitle: ${await page.title()}\nViewport: 1280x720\n${snapshot}${snapshot.length >= 24000 ? "\n[Observation truncated]" : ""}\n${logs.join("\n")}`,
                        screenshot,
                      }
                    } finally {
                      signal.removeEventListener("abort", abort)
                      const current = owned.get(context.sessionID)
                      if (current) {
                        current.timer = setTimeout(() => {
                          void close(context.sessionID)
                        }, idle)
                        current.timer.unref()
                      }
                    }
                  },
                  catch: (error) =>
                    new Tool.Failure({
                      message: `${started ? "Outcome may have occurred; observe before retrying" : "Not executed"}: ${String(error)}`,
                    }),
                })
                if (!result.screenshot) return { text: result.text }
                const name = yield* outputs
                  .image(context.sessionID, result.screenshot)
                  .pipe(Effect.mapError((error) => new Tool.Failure({ message: error.message })))
                const message =
                  context.inputModalities === undefined
                    ? yield* sessions.message(context.assistantMessageID)
                    : undefined
                const model =
                  context.inputModalities === undefined && message?.message.type === "assistant"
                    ? yield* catalog.model.get(message.message.model.providerID, message.message.model.id)
                    : undefined
                const modelVisible = (context.inputModalities ?? model?.capabilities.input)?.includes("image") === true
                return {
                  text: `${result.text}\n${modelVisible ? "Screenshot attached to model input." : "Screenshot saved for the user; model has not viewed the image."}`,
                  screenshot: {
                    data: result.screenshot.toString("base64"),
                    mime: "image/png" as const,
                    name,
                    modelVisible,
                  },
                }
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
    return Service.of({ close: (id) => Effect.promise(() => close(id)) })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Catalog.node, SessionStore.node, ToolOutputStore.node],
})
