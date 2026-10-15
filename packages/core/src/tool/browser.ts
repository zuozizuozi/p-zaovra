export * as BrowserTool from "./browser"

import { Context, DateTime, Effect, Layer, Schema, SchemaGetter } from "effect"
import { EventV2 } from "../event"
import { SessionEvent } from "../session/event"
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
import { BrowserNetwork } from "./browser-network"

const Target = Schema.Union([
  Schema.Struct({
    role: Schema.Literals([
      "alert",
      "alertdialog",
      "application",
      "article",
      "banner",
      "blockquote",
      "button",
      "caption",
      "cell",
      "checkbox",
      "code",
      "columnheader",
      "combobox",
      "complementary",
      "contentinfo",
      "definition",
      "deletion",
      "dialog",
      "directory",
      "document",
      "emphasis",
      "feed",
      "figure",
      "form",
      "generic",
      "grid",
      "gridcell",
      "group",
      "heading",
      "img",
      "insertion",
      "link",
      "list",
      "listbox",
      "listitem",
      "log",
      "main",
      "marquee",
      "math",
      "meter",
      "menu",
      "menubar",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "navigation",
      "none",
      "note",
      "option",
      "paragraph",
      "presentation",
      "progressbar",
      "radio",
      "radiogroup",
      "region",
      "row",
      "rowgroup",
      "rowheader",
      "scrollbar",
      "search",
      "searchbox",
      "separator",
      "slider",
      "spinbutton",
      "status",
      "strong",
      "subscript",
      "superscript",
      "switch",
      "tab",
      "table",
      "tablist",
      "tabpanel",
      "term",
      "textbox",
      "time",
      "timer",
      "toolbar",
      "tooltip",
      "tree",
      "treegrid",
      "treeitem",
    ]),
    name: Schema.String,
  }),
  Schema.Struct({ label: Schema.String }),
  Schema.Struct({ selector: Schema.String }),
])
const Actions = [
  Schema.Struct({ action: Schema.Literal("click"), target: Target }),
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
] as const
const Action = Schema.Union(Actions)
const Observation = Schema.Literals(["snapshot", "screenshot"])
const Batch = Schema.Struct({
  action: Schema.Literal("batch"),
  actions: Schema.Array(Action).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  observation: Schema.optional(Observation),
})
const BatchInput = Schema.Struct({
  action: Schema.Literal("batch"),
  actions: Schema.Array(Schema.Union([Action, Schema.Struct({ action: Observation })]))
    .check(Schema.isMinLength(1), Schema.isMaxLength(5))
    .pipe(
      Schema.annotateKey({
        messageMissingKey:
          'Batch requires actions. Example: {"action":"batch","actions":[{"action":"press","key":"Tab"}],"observation":"snapshot"}',
      }),
    ),
  observation: Schema.optional(Observation),
})
  .check(
    Schema.makeFilter((input) => {
      const tail = input.actions.at(-1)
      const observation = tail?.action === "snapshot" || tail?.action === "screenshot" ? tail.action : undefined
      const actions = observation ? input.actions.slice(0, -1) : input.actions
      return (
        (actions.length >= 1 &&
          actions.length <= 4 &&
          actions.every((action) => action.action !== "snapshot" && action.action !== "screenshot") &&
          (!observation || !input.observation || observation === input.observation)) ||
        'Expected 1–4 actions and at most one final observation, with no conflicting observation. Example: {"action":"batch","actions":[{"action":"press","key":"Tab"},{"action":"snapshot"}]}'
      )
    }),
  )
  .pipe(
    Schema.decodeTo(Batch, {
      decode: SchemaGetter.transform((input) => {
        const tail = input.actions.at(-1)
        const observation =
          tail?.action === "snapshot" || tail?.action === "screenshot" ? tail.action : input.observation
        return {
          action: input.action,
          actions: input.actions.filter(
            (action): action is typeof Action.Type => action.action !== "snapshot" && action.action !== "screenshot",
          ),
          ...(observation ? { observation } : {}),
        }
      }),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  )
const Input = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("open"),
    url: Schema.String,
    allowOrigins: Schema.optional(Schema.Array(Schema.String)),
  }),
  ...Actions,
  Schema.Struct({ action: Schema.Literal("click_position"), x: Schema.Number, y: Schema.Number }),
  Schema.Struct({ action: Schema.Literals(["snapshot", "screenshot", "console", "close"]) }),
  BatchInput,
])
const Step = Schema.Struct({
  index: Schema.Int,
  action: Schema.String,
  status: Schema.Literals(["executed", "not_executed", "outcome_unknown"]),
})
const Output = Schema.Struct({
  text: Schema.String,
  steps: Schema.optional(Schema.Array(Step)),
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

/** Validate the public key vocabulary before a keyboard action can have effects. */
export function normalizeKey(value: string, holdMs = 0) {
  const aliases: Record<string, string> = {
    ctrl: "Control",
    control: "Control",
    alt: "Alt",
    shift: "Shift",
    meta: "Meta",
    cmd: "Meta",
    command: "Meta",
    esc: "Escape",
    escape: "Escape",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    space: "Space",
    backspace: "Backspace",
    delete: "Delete",
    del: "Delete",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    controlormeta: "ControlOrMeta",
  }
  const parts = value === "+" ? [value] : (value.match(/[^+]+|\+(?=$)/g) ?? [])
  const keys = parts.map((part) => aliases[part.toLowerCase()] ?? part)
  const modifiers = ["Control", "Alt", "Shift", "Meta", "ControlOrMeta"]
  const named =
    /^(?:Arrow(?:Up|Down|Left|Right)|Enter|Tab|Escape|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|CapsLock|NumLock|ScrollLock|Pause|PrintScreen|ContextMenu|F(?:[1-9]|1[0-9]|2[0-4])|Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter))$/
  if (
    !keys.length ||
    parts.join("+") !== value ||
    (holdMs > 0 && keys.length > 1) ||
    keys.some((key, index) =>
      index < keys.length - 1
        ? !modifiers.includes(key)
        : !modifiers.includes(key) && !named.test(key) && !/^[\x20-\x7e]$/.test(key),
    )
  )
    throw new Error(
      "Invalid keyboard key: use a supported key such as Enter, Escape, ArrowDown or Control+a; holdMs requires a single key",
    )
  return keys.join("+")
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
    const events = yield* EventV2.Service
    const idle = yield* IdleTimeout
    const owned = new Map<SessionSchema.ID, Owned>()
    const locks = KeyedMutex.makeUnsafe<SessionSchema.ID>()
    const close = async (id: SessionSchema.ID, expected?: Owned) => {
      const current = owned.get(id)
      if (!current || (expected && current !== expected)) return
      owned.delete(id)
      clearTimeout(current.timer)
      await current.browser.close().catch(() => {})
    }
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => Promise.all([...owned.keys()].map((id) => close(id)))).pipe(Effect.asVoid),
    )

    yield* tools
      .register({
        browser: Tool.make({
          description:
            "Use this tool to observe and interact with local web previews instead of writing browser scripts. Run repeatable assertions with bash and the project's tests; screenshots do not prove completion. Open an authorized local URL first; use observed unique roles/labels/selectors or screenshot coordinates. Use batch for up to 4 already-known click/type/press/scroll actions with one final snapshot (default) or screenshot. Batch stops at the first error; inspect step statuses before continuing, never replay completed actions. Use single steps when the next target depends on a new observation. Explicitly authorize any additional resource origins with allowOrigins on open. No uploads, downloads, or arbitrary JavaScript. Built-in browser does not support Web Workers; use the system browser for full capabilities. Streaming is supported for GET/HEAD fetch, XHR and EventSource; Chromium may resend native GET requests. Navigation and mutating requests retain bounded zero-retry transport.",
          input: Input,
          output: Output,
          structured: Schema.Struct({
            text: Schema.String,
            steps: Schema.optional(Schema.Array(Step)),
            screenshot: Schema.optional(
              Schema.Struct({ mime: Schema.Literal("image/png"), name: Schema.String, modelVisible: Schema.Boolean }),
            ),
          }),
          toStructuredOutput: ({ output }) => ({
            text: output.text,
            ...(output.steps ? { steps: output.steps } : {}),
            ...(output.screenshot
              ? {
                  screenshot: {
                    mime: output.screenshot.mime,
                    name: output.screenshot.name,
                    modelVisible: output.screenshot.modelVisible,
                  },
                }
              : {}),
          }),
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
          execute: (input, context) => {
            const steps: { index: number; action: string; status: typeof Step.Type.status }[] =
              input.action === "batch"
                ? input.actions.map((action, index) => ({
                    index: index + 1,
                    action: action.action,
                    status: "not_executed",
                  }))
                : []
            const summary = () => `Batch steps: ${JSON.stringify(steps)}`
            return locks.withLock(context.sessionID)(
              Effect.gen(function* () {
                const keys = yield* Effect.try({
                  try: () =>
                    (input.action === "batch" ? input.actions : [input]).map((action) =>
                      action.action === "press" ? normalizeKey(action.key, action.holdMs) : undefined,
                    ),
                  catch: (error) =>
                    new Tool.Failure({ message: `Not executed: ${String(error)}`, metadata: { phase: "input" } }),
                })
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
                    let owner = owned.get(context.sessionID)
                    const abort = () => {
                      if (owner) void close(context.sessionID, owner)
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
                          const network = await BrowserNetwork.install(browserContext, state.origins, log)
                          await network.stream(page)
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
                          if (signal.aborted) {
                            await browser.close()
                            throw new Error("Cancelled")
                          }
                          owner = current
                          owned.set(context.sessionID, current)
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
                      // Validate selector syntax for the entire batch, but resolve
                      // uniqueness at each step because earlier actions can change the DOM.
                      if (input.action === "batch")
                        for (const action of input.actions)
                          if ((action.action === "click" || action.action === "type") && "selector" in action.target)
                            await page.locator(action.target.selector).count()
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
                      const perform = async (
                        action: typeof Action.Type,
                        key?: string,
                        step?: (typeof steps)[number],
                      ) => {
                        if (signal.aborted) throw new Error("Cancelled")
                        if (action.action === "click" || action.action === "type") {
                          const locator = await locate(action.target)
                          if (signal.aborted) throw new Error("Cancelled")
                          if (step) step.status = "outcome_unknown"
                          started = true
                          if (action.action === "click") await locator.click()
                          if (action.action === "type") await locator.fill(action.text)
                        }
                        if (action.action === "press") {
                          if (step) step.status = "outcome_unknown"
                          started = true
                          if (action.holdMs) {
                            await page.keyboard.down(key!)
                            try {
                              await new Promise((resolve) => setTimeout(resolve, action.holdMs))
                            } finally {
                              await page.keyboard.up(key!).catch(() => {})
                            }
                          } else await page.keyboard.press(key!)
                        }
                        if (action.action === "scroll") {
                          if (step) step.status = "outcome_unknown"
                          started = true
                          await page.mouse.wheel(action.x, action.y)
                        }
                        if (signal.aborted) throw new Error("Cancelled")
                      }
                      if (input.action === "batch") {
                        for (const [index, action] of input.actions.entries()) {
                          if (signal.aborted) throw new Error("Cancelled")
                          started = false
                          await perform(action, keys[index], steps[index])
                          steps[index]!.status = "executed"
                        }
                      }
                      if (
                        input.action === "click" ||
                        input.action === "type" ||
                        input.action === "press" ||
                        input.action === "scroll"
                      )
                        await perform(input, keys[0])
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
                      if (signal.aborted) throw new Error("Cancelled")
                      const snapshot =
                        input.action === "console"
                          ? ""
                          : (await page.locator("body").ariaSnapshot({ timeout: 8000 })).slice(0, 24000)
                      const logs = current.logs.splice(0)
                      const screenshot =
                        input.action === "screenshot" ||
                        (input.action === "batch" && input.observation === "screenshot")
                          ? await page.screenshot({ type: "png", fullPage: false, timeout: 8000 })
                          : undefined
                      return {
                        text: `${BrowserNetwork.workerNotice}\nURL: ${page.url()}\nTitle: ${await page.title()}\nViewport: 1280x720\n${snapshot}${snapshot.length >= 24000 ? "\n[Observation truncated]" : ""}\n${logs.join("\n")}`,
                        screenshot,
                      }
                    } finally {
                      signal.removeEventListener("abort", abort)
                      const current = owner
                      if (!signal.aborted && current && owned.get(context.sessionID) === current) {
                        clearTimeout(current.timer)
                        current.timer = setTimeout(() => {
                          void close(context.sessionID, current)
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
                if (!result.screenshot)
                  return {
                    text: steps.length ? `${summary()}\n${result.text}` : result.text,
                    ...(steps.length ? { steps } : {}),
                  }
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
                  ...(steps.length ? { steps } : {}),
                  text: `${steps.length ? summary() + "\n" : ""}${result.text}\n${modelVisible ? "Screenshot attached to model input." : "Screenshot saved for the user; model has not viewed the image."}`,
                  screenshot: {
                    data: result.screenshot.toString("base64"),
                    mime: "image/png" as const,
                    name,
                    modelVisible,
                  },
                }
              }).pipe(
                Effect.mapError((error) =>
                  steps.length
                    ? new Tool.Failure({
                        message: `${error.message}\n${summary()}. Do not replay executed steps.`,
                        metadata: error.metadata,
                      })
                    : error,
                ),
                // Retain the partial-action ledger when Stop prevents an ordinary result.
                Effect.ensuring(
                  Effect.suspend(() =>
                    steps.length
                      ? events
                          .publish(SessionEvent.Tool.Progress, {
                            sessionID: context.sessionID,
                            assistantMessageID: context.assistantMessageID,
                            callID: context.toolCallID,
                            timestamp: DateTime.nowUnsafe(),
                            structured: { steps: steps.map((step) => ({ ...step })) },
                            content: [{ type: "text", text: summary() }],
                          })
                          .pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
              ),
            )
          },
        }),
      })
      .pipe(Effect.orDie)
    return Service.of({ close: (id) => Effect.promise(() => close(id)) })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, Catalog.node, SessionStore.node, ToolOutputStore.node, EventV2.node],
})
