import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createReviewEntry } from "../../src/pages/session/review-entry"
import { manualChange, reviewEntrySource, untilReviewEntry } from "../../src/pages/session/review-entry.test-helper"

const [state, setState] = createStore({ modern: true, active: "context", opened: true, mode: "turn", width: 1440 })
const language = { t: (key: string) => key }
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/settings", () => ({
  useSettings: () => ({
    general: { newLayoutDesigns: () => state.modern },
    visibility: { fileTree: () => false },
  }),
}))
mock.module("@/context/layout", () => ({
  useLayout: () => ({ fileTree: { opened: () => false, width: () => 240, tab: () => "all" } }),
}))
mock.module("@/context/command", () => ({
  useCommand: () => ({ keybind: () => "", keybindParts: () => [], trigger: () => {} }),
}))
mock.module("@/context/file", () => ({
  useFile: () => ({
    ready: () => false,
    tree: { state: () => ({ loaded: true }), children: () => [] },
    pathFromTab: (tab: string) => (tab.startsWith("file://") ? tab.slice(7) : undefined),
    tab: (path: string) => (path.startsWith("file://") ? path : "file://" + path),
    load: () => {},
  }),
}))
mock.module("@/context/sdk", () => ({ useSDK: () => () => ({ directory: "F:/dom807" }) }))
mock.module("@zaovra-ai/ui/context/dialog", () => ({ useDialog: () => ({}) }))
mock.module("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    params: { id: "session807", dir: btoa("F:/dom807") },
    sessionKey: () => "session807",
    tabs: () => ({
      active: () => state.active,
      all: () => ["context", "open-file", "file://manual.txt"],
      preview: () => undefined,
      setActive: (active: string) => setState("active", active),
      open: () => {},
      close: () => {},
    }),
    view: () => ({
      reviewPanel: { opened: () => state.opened, open: () => setState("opened", true) },
    }),
  }),
}))
// The query, controls, tabs, and side-panel shell are real; unrelated file viewers are outside this regression.
mock.module("@/components/artifact-preview-panel", () => ({ ArtifactPreviewPanel: () => null }))
mock.module("@/components/file-tree", () => ({ default: () => null }))
mock.module("@/components/session-context-usage", () => ({ SessionContextUsage: () => null }))
mock.module("@/components/session", () => ({
  SessionContextTab: () => <div>context content</div>,
  SortableTab: () => null,
  SortableTabV2: () => null,
  FileVisual: () => null,
}))
mock.module("@/components/session/open-in-app-v2", () => ({ OpenInAppV2: () => null }))
mock.module("@/pages/session/file-tabs", () => ({ FileTabContent: () => <div>file content</div> }))
mock.module("@/pages/session/v2/session-file-browser-tab", () => ({
  SessionFileBrowserTab: () => <div>file browser content</div>,
}))
const { SessionPanelControls } = await import("../../src/components/session/session-panel-controls")
const { SessionSidePanel } = await import("../../src/pages/session/session-side-panel")
const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

async function mount(input: { modern: boolean; active: string; width: number; changed?: boolean; error?: boolean }) {
  setState({ ...input, opened: true, mode: "turn" })
  window.resizeTo(input.width, 1000)
  const source = await reviewEntrySource()
  source.set("F:/dom807", { files: input.changed ? manualChange : [], error: input.error })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  cleanups.push(
    () => source.stop(),
    () => client.clear(),
  )
  const host = document.createElement("main")
  document.body.append(host)
  let entry!: ReturnType<typeof createReviewEntry>
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        {(() => {
          entry = createReviewEntry({
            workspace: () => ({
              key: ["session-vcs", "F:/dom807", "main", "main", "server807"],
              git: true,
              client: source.client("F:/dom807"),
            }),
            reviewCount: () => 0,
            turnCount: () => 0,
            setMode: (mode) => setState("mode", mode),
          })
          return (
            <>
              <SessionPanelControls
                hasChanges={entry.hasChanges()}
                terminal
                opened={state.opened}
                onFiles={() => setState("active", "open-file")}
                onChanges={() => {
                  entry.select()
                  setState("active", "review")
                }}
                onContext={() => setState("active", "context")}
                onTerminal={() => {}}
              />
              <SessionSidePanel
                mobile={input.width < 768}
                canReview={() => true}
                diffs={() => []}
                diffsReady={() => false}
                empty={() => "loading"}
                hasReview={() => false}
                hasChanges={entry.hasChanges}
                onReview={entry.select}
                reviewHasFocusableContent={() => false}
                reviewCount={() => 0}
                reviewPanel={() => <div>review content</div>}
                fileBrowserState={
                  input.modern || input.width < 768
                    ? {
                        sidebarOpened: () => false,
                        sidebarWidth: () => 240,
                        sidebarTransition: () => false,
                        resizeSidebar: () => {},
                        toggleSidebar: () => {},
                      }
                    : undefined
                }
                focusReviewDiff={() => {}}
                reviewSnap={false}
                size={{ active: () => false, start: () => {}, touch: () => {} }}
              />
            </>
          )
        })()}
      </QueryClientProvider>
    ),
    host,
  )
  cleanups.push(dispose)
  return { host, source, entry }
}

for (const modern of [false, true]) {
  for (const width of [1440, 390]) {
    for (const active of ["file://manual.txt", "context", "open-file"]) {
      test(`807 ${modern ? "modern" : "legacy"} ${width} persisted ${active}: status unlocks both entry points`, async () => {
        const app = await mount({ modern, width, active, changed: true })
        expect(app.host.querySelector('[aria-label="command.review.toggle"]')).toBeNull()
        await untilReviewEntry(() => app.entry.query.isSuccess)
        const control = app.host.querySelector<HTMLButtonElement>('[aria-label="command.review.toggle"]')!
        expect(control).not.toBeNull()
        control.click()
        expect(state.active).toBe("review")
        expect(state.mode).toBe("git")
        setState({ active, mode: "turn" })
        const tab = app.host.querySelector<HTMLElement>("#session-side-panel-review-tab")!
        expect(tab).not.toBeNull()
        expect(tab.textContent).not.toContain("filesChanged")
        tab.click()
        expect(state.active).toBe("review")
        expect(state.mode).toBe("git")
        expect(app.source.requests).toEqual(["/vcs/status"])
      })
    }
  }
}

test("807 DOM keeps clean and failed workspaces hidden, retry reveals real changes, clearing hides both entries", async () => {
  const app = await mount({ modern: true, width: 390, active: "context", error: true })
  await untilReviewEntry(() => app.entry.query.isError)
  expect(app.entry.query.isSuccess).toBe(false)
  expect(app.host.querySelector('[aria-label="command.review.toggle"]')).toBeNull()
  expect(app.host.querySelector("#session-side-panel-review-tab")).toBeNull()
  app.source.set("F:/dom807", { files: [] })
  await app.entry.query.refetch()
  expect(app.host.querySelector('[aria-label="command.review.toggle"]')).toBeNull()
  app.source.set("F:/dom807", { files: manualChange })
  await app.entry.query.refetch()
  expect(app.host.querySelector('[aria-label="command.review.toggle"]')).not.toBeNull()
  expect(app.host.querySelector("#session-side-panel-review-tab")).not.toBeNull()
  app.source.set("F:/dom807", { files: [] })
  await app.entry.query.refetch()
  expect(app.host.querySelector('[aria-label="command.review.toggle"]')).toBeNull()
  expect(app.host.querySelector("#session-side-panel-review-tab")).toBeNull()
})
