import { afterEach, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { Part, ToolPart } from "@zaovra-ai/sdk/v2"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { TurnProcessSummary, hasTurnProcessContent } from "../../src/pages/session/timeline/turn-process-summary"
const en = await import("../../src/i18n/en")
const zh = await import("../../src/i18n/zh")
const dictionaries: Record<string, Record<string, string>> = { en: en.dict, zh: zh.dict }
const closers: (() => void)[] = []
afterEach(() => closers.splice(0).forEach((close) => close()))
const text: Part = { id: "text", messageID: "answer", sessionID: "787", type: "text", text: "Visible answer" }
const thought: Part = {
  id: "thought",
  messageID: "answer",
  sessionID: "787",
  type: "reasoning",
  text: "Inspecting files",
  time: { start: 1 },
}
const tool: ToolPart = {
  id: "tool",
  messageID: "answer",
  sessionID: "787",
  type: "tool",
  tool: "read",
  callID: "read",
  state: {
    status: "completed",
    input: { filePath: "file" },
    output: "data",
    title: "read",
    metadata: {},
    time: { start: 1, end: 2 },
  },
}
test.each(["zh", "en"] as const)("787 %s process disclosure appears only when expandable content exists", (locale) => {
  const i18n = {
    locale: () => locale,
    t: (key: string, values?: Record<string, string | number | boolean>) =>
      (dictionaries[locale][key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name) => String(values?.[name] ?? "")),
  }
  const [state, setState] = createStore<{ parts: Part[]; reasoning: boolean; processes: number; folded: boolean }>({
    parts: [],
    reasoning: true,
    processes: 0,
    folded: true,
  })
  const root = document.createElement("main")
  document.body.append(root)
  const close = render(
    () => (
      <I18nProvider value={i18n}>
        <TurnProcessSummary
          tools={state.parts.filter((part): part is ToolPart => part.type === "tool")}
          thoughts={state.parts.filter((part) => part.type === "reasoning" && part.text.trim()).length}
          processes={state.processes}
          seconds={13}
          hasContent={hasTurnProcessContent(state.parts, {
            answerMessageID: "answer",
            showReasoning: state.reasoning,
            coveredFailure: () => false,
            processes: state.processes,
          })}
          folded={state.folded}
          onToggle={() => setState("folded", !state.folded)}
        />
      </I18nProvider>
    ),
    root,
  )
  closers.push(() => {
    close()
    root.remove()
  })
  expect(root.querySelector("button")).toBeNull()
  expect(root.textContent).toContain(i18n.t("session.turn.duration", { seconds: 13 }))
  setState("parts", [
    { ...text, text: "   " },
    { ...thought, text: "" },
  ])
  expect(root.querySelector("button")).toBeNull()
  setState("parts", [text])
  expect(root.querySelector("button")).toBeNull()
  setState("parts", [thought])
  expect(root.querySelector("button")?.getAttribute("aria-expanded")).toBe("false")
  root.querySelector("button")!.click()
  expect(root.querySelector("button")?.getAttribute("aria-expanded")).toBe("true")
  setState("reasoning", false)
  expect(root.querySelector("button")).toBeNull()
  setState("parts", [{ ...text, messageID: "intermediate" }])
  expect(root.querySelector("button")).not.toBeNull()
  setState("parts", [tool])
  expect(root.querySelector("button")).not.toBeNull()
  setState("parts", [{ ...tool, tool: "todowrite" }])
  expect(root.querySelector("button")).toBeNull()
  setState("parts", [])
  setState("processes", 1)
  expect(root.querySelector("button")).not.toBeNull()
  setState("processes", 0)
  expect(root.querySelector("button")).toBeNull()
})
