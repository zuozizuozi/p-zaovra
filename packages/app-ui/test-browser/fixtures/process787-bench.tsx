import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { dict } from "../../../ui/src/i18n/zh"
import { TurnProcessSummary } from "../../src/pages/session/timeline/turn-process-summary"
const app = await import("../../src/i18n/zh")
const dictionary: Record<string, string> = { ...dict, ...app.dict }
const i18n = {
  locale: () => "zh",
  t: (key: string, values?: Record<string, string | number | boolean>) =>
    (dictionary[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name) => String(values?.[name] ?? "")),
}
function sample() {
  const root = document.createElement("main")
  document.body.append(root)
  const [state, setState] = createStore({ content: false, folded: true })
  const begin = performance.now()
  const close = render(
    () => (
      <I18nProvider value={i18n}>
        <TurnProcessSummary
          tools={[]}
          hasContent={state.content}
          processes={state.content ? 1 : 0}
          folded={state.folded}
          onToggle={() => setState("folded", !state.folded)}
        />
      </I18nProvider>
    ),
    root,
  )
  for (let index = 0; index < 200; index++) {
    setState({ content: index % 4 !== 0, folded: index % 2 === 0 })
    root.querySelector("button")?.click()
  }
  const ms = performance.now() - begin
  close()
  root.remove()
  return ms
}
Array.from({ length: 3 }, sample)
const samples = Array.from({ length: 21 }, sample)
const sorted = samples.toSorted((a, b) => a - b)
console.log(
  JSON.stringify({
    benchmark: "787 actual Solid TurnProcessSummary mount and 200 content/toggle updates",
    samples,
    medianMs: sorted[10],
    p95Ms: sorted[19],
    modelCalls: 0,
    domOnly: true,
  }),
)
process.exit(0)
