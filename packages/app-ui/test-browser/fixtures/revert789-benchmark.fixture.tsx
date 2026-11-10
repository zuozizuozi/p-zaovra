import { expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"

mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("@/context/settings", () => ({ useSettings: () => ({ general: { newLayoutDesigns: () => true } }) }))

const { SessionRevertDock } = await import("@/pages/session/composer/session-revert-dock")

test("789 measures the real restore-message dock across 200 updates", async () => {
  const [state, setState] = createStore({ items: [{ id: "msg_fixture", text: "Original prompt" }] })
  const host = document.createElement("main")
  document.body.append(host)
  const dispose = render(() => <SessionRevertDock items={state.items} onRestore={() => {}} />, host)
  for (const update of Array.from({ length: 2000 }, (_, index) => index))
    setState("items", [{ id: "msg_fixture", text: `Warmup ${update}` }])
  const samples = Array.from({ length: 7 }, (_, sample) => {
    const start = performance.now()
    for (const update of Array.from({ length: 200 }, (_, index) => index))
      setState("items", [{ id: "msg_fixture", text: `Prompt ${sample}:${update}` }])
    return performance.now() - start
  })
  expect(host.textContent).toContain("Prompt 6:199")
  console.log(JSON.stringify({ warmup: 2000, updates: 200, samples, medianMs: [...samples].sort((a, b) => a - b)[3] }))
  dispose()
  host.remove()
})
