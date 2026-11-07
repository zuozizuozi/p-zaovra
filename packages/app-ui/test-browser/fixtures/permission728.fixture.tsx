import { expect, test } from "bun:test"
import { createRoot, ErrorBoundary, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { PlatformProvider } from "../../src/context/platform"
import { LanguageProvider } from "../../src/context/language"
import { PermissionModeControl } from "../../src/components/permission-mode-control"
import { PromptInputV2, type PromptInputV2PersistedState } from "@zaovra-ai/session-ui/v2/prompt-input"
import { createPromptInputV2Controller } from "@zaovra-ai/session-ui/v2/prompt-input/interaction"

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
function mount(children: () => JSX.Element) {
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () => (
      <PlatformProvider
        value={{
          platform: "web",
          openLink() {},
          restart: async () => {},
          back() {},
          forward() {},
          notify: async () => {},
        }}
      >
        <LanguageProvider locale="zh">{children()}</LanguageProvider>
      </PlatformProvider>
    ),
    root,
  )
  return {
    root,
    close() {
      dispose()
      root.remove()
    },
  }
}

test("728 actual controlled permission menu in composer slot remains mounted over ten cycles", async () => {
  const errors: unknown[] = []
  let mounts = 0
  const [menu, setMenu] = createStore<{ open: boolean; mode: "ask" | "automatic" | "full" }>({
    open: false,
    mode: "ask",
  })
  const [state, setState] = createStore<PromptInputV2PersistedState>({ prompt: [], cursor: 0, context: { items: [] } })
  const owned = createRoot((dispose) => ({
    dispose,
    controller: createPromptInputV2Controller({
      store: [state, setState],
      commands: () => [],
      context: () => [],
      searchContextFiles: () => [],
      view: { submit: { stopping: () => false, onSubmit() {}, onStop() {} } },
    }),
  }))
  function Control() {
    mounts++
    return (
      <PermissionModeControl
        mode={menu.mode}
        open={menu.open}
        onOpenChange={(open) => setMenu("open", open)}
        onChange={(mode) => setMenu("mode", mode)}
      />
    )
  }
  const view = mount(() => (
    <ErrorBoundary
      fallback={(error) => {
        errors.push(error)
        return <div data-error>{String(error)}</div>
      }}
    >
      <PromptInputV2 controller={owned.controller} modelControl={<Control />} />
    </ErrorBoundary>
  ))
  try {
    expect(mounts).toBe(1)
    for (let index = 0; index < 10; index++) {
      const trigger = view.root.querySelector<HTMLElement>('[data-component="permission-chip"]')!
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
      await tick()
      expect(errors.map(String)).toEqual([])
      const mode = (["automatic", "full", "ask"] as const)[index % 3]
      const item = document.querySelector<HTMLElement>('[data-permission-menu] [data-mode="' + mode + '"]')!
      expect(item).not.toBeNull()
      item.focus()
      item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      await tick()
      expect(errors.map(String)).toEqual([])
      expect(menu.mode).toBe(mode)
      expect(menu.open).toBe(false)
      expect(view.root.querySelectorAll('[data-component="permission-chip"]')).toHaveLength(1)
    }
  } finally {
    view.close()
    owned.dispose()
  }
})
