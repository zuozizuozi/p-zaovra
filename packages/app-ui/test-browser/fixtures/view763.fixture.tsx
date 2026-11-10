import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { dict } from "../../src/i18n/en"
import type { ConversationView } from "../../src/utils/conversation-view"

const [state, setState] = createStore({
  modern: true,
  view: undefined as ConversationView | undefined,
  review: false,
})
const language = { locale: () => "en", t: (key: string) => (dict as Record<string, string>)[key] ?? key }
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/layout", () => ({
  useLayout: () => ({ projects: { list: () => [] }, fileTree: { opened: () => false, toggle: () => {} } }),
}))
mock.module("@/context/command", () => ({
  useCommand: () => ({ keybind: () => "", keybindParts: () => [], trigger: () => {} }),
}))
mock.module("@/context/server", () => ({ useServer: () => ({ isLocal: () => true }) }))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "desktop", os: "windows" }) }))
mock.module("@/context/settings", () => ({
  useSettings: () => ({
    general: { newLayoutDesigns: () => state.modern },
    visibility: { search: () => false, status: () => false },
  }),
}))
mock.module("@/context/sync", () => ({ useSync: () => () => ({ data: { message: {}, agent: [] } }) }))
mock.module("@/context/terminal", () => ({ useTerminal: () => ({ active: () => undefined }) }))
mock.module("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    params: { id: "fixture763", dir: btoa("F:/synthetic763") },
    view: () => ({
      terminal: { opened: () => false, toggle: () => {} },
      reviewPanel: { opened: () => state.review, toggle: () => setState("review", !state.review), open: () => {} },
      conversationView: {
        get: () => state.view,
        set: (value: ConversationView | undefined) => setState("view", value),
      },
    }),
    tabs: () => ({ open: () => {}, setActive: () => {} }),
  }),
}))
mock.module("@/components/titlebar", () => ({
  useTitlebarRightMount: () => () => document.getElementById("zaovra-titlebar-right"),
}))
mock.module("@/components/status-popover", () => ({ StatusPopover: () => null, StatusPopoverV2: () => null }))
mock.module("@/utils/persist", () => ({
  Persist: { global: (key: string) => key },
  persisted: <T,>(_: unknown, value: T) => value,
}))
const { SessionHeader } = await import("../../src/components/session/session-header")
const { SessionPanelControls } = await import("../../src/components/session/session-panel-controls")
const disposals: Array<() => void> = []
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  setState({ modern: true, view: undefined, review: false })
})
function mountHeader(onAction?: (action: string) => void) {
  const caption = document.createElement("div")
  caption.id = "zaovra-titlebar-right"
  document.body.append(caption)
  const host = document.createElement("main")
  document.body.append(host)
  const dispose = render(
    () => (
      <SessionHeader
        controls={
          onAction
            ? () => (
                <SessionPanelControls
                  hasChanges
                  terminal
                  opened={state.review}
                  onFiles={() => onAction("files")}
                  onChanges={() => onAction("changes")}
                  onContext={() => onAction("context")}
                  onTerminal={() => onAction("terminal")}
                />
              )
            : undefined
        }
      />
    ),
    host,
  )
  return { caption, host, dispose }
}
if (process.env.ZAOVRA_HEADER_BENCH === "1") {
  test("763 production SessionHeader mount/dispose CPU", () => {
    const samples = Array.from({ length: 13 }, () => {
      const start = performance.now()
      for (let index = 0; index < 32; index++) {
        const mounted = mountHeader()
        mounted.dispose()
        document.body.replaceChildren()
      }
      return performance.now() - start
    })
    const measured = samples.slice(2).toSorted((a, b) => a - b)
    console.log(
      JSON.stringify({
        benchmark: "763 actual SessionHeader mount/dispose",
        mountsPerSample: 32,
        samples,
        medianMs: measured[5],
        modelCalls: 0,
      }),
    )
  })
} else {
  test("792 caption without supplied panel controls does not invent actions", () => {
    const mounted = mountHeader()
    disposals.push(mounted.dispose)
    expect(mounted.caption.textContent).not.toContain("View")
    expect(mounted.caption.querySelectorAll("button")).toHaveLength(0)
  })
  test.each([true, false])(
    "792 %s caption mounts the actual shared file/change/context/terminal controls",
    (modern) => {
      setState("modern", modern)
      const actions: string[] = []
      const mounted = mountHeader((action) => actions.push(action))
      disposals.push(mounted.dispose)
      const buttons = mounted.caption.querySelectorAll<HTMLButtonElement>(
        '[data-component="session-panel-controls"] button',
      )
      expect(buttons).toHaveLength(4)
      for (const button of buttons) button.click()
      expect(actions).toEqual(["files", "changes", "context", "terminal"])
    },
  )
}

if (process.env.ZAOVRA_HEADER_BENCH !== "1") {
  const { DropdownMenu } = await import("@zaovra-ai/ui/dropdown-menu")
  const { MenuV2 } = await import("@zaovra-ai/ui/v2/menu-v2")
  const { SessionViewMenu } = await import("../../src/components/session/session-view-menu")
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  const mountMenu = (modern: boolean) => {
    const Menu = modern ? MenuV2 : DropdownMenu
    const host = document.createElement("main")
    document.body.append(host)
    disposals.push(
      render(
        () => (
          <Menu open>
            <Menu.Trigger>More options</Menu.Trigger>
            <Menu.Portal>
              <Menu.Content>
                <SessionViewMenu
                  modern={modern}
                  value={state.view}
                  onChange={(value) => setState("view", value)}
                  reviewOpened={state.review}
                  onReviewToggle={() => setState("review", !state.review)}
                />
              </Menu.Content>
            </Menu.Portal>
          </Menu>
        ),
        host,
      ),
    )
  }
  test.each([true, false])("763 %s menu changes actual four-option group and returns to default", async (modern) => {
    mountMenu(modern)
    await settle()
    for (const value of ["normal", "thinking", "detailed", "default"] as const) {
      const label = language.t(`conversation.view.${value}`)
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
        (node) => node.textContent?.trim() === label,
      )!
      expect(item).toBeDefined()
      item.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }))
      await settle()
      expect(state.view).toBe(value === "default" ? undefined : value)
      expect(item.getAttribute("aria-checked")).toBe("true")
    }
  })
  test.each([true, false])("792 %s view menu keeps review and removes the empty artifact entry", async (modern) => {
    mountMenu(modern)
    await settle()
    const review = document.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!
    expect(review.textContent).toContain(language.t("command.review.toggle"))
    review.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }))
    await settle()
    expect(state.review).toBe(true)
    expect(review.getAttribute("aria-checked")).toBe("true")
    expect(
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].some(
        (node) => node.textContent?.trim() === "View artifacts",
      ),
    ).toBe(false)
  })
  test("763 old layout no longer exposes its temporary view select in caption", () => {
    setState("modern", false)
    const mounted = mountHeader()
    disposals.push(mounted.dispose)
    expect(mounted.caption.querySelector('[data-action="session-conversation-view"]')).toBeNull()
    expect(mounted.caption.querySelectorAll("button").length).toBeGreaterThan(0)
  })
}
