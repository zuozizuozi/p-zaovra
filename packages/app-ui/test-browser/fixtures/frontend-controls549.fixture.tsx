import { expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { ReasoningBlock } from "../../../session-ui/src/components/reasoning-block"
import { enrichLocalProject } from "../../src/context/local-project"
import { ArtifactExternal } from "../../src/components/artifact-external"
import { artifactViewer } from "../../src/artifact-preview"
import { dict } from "../../../ui/src/i18n/zh"
const app = await import("../../src/i18n/zh")
const translations: Record<string, string> = { ...app.dict, ...dict }
const language = { locale: () => "zh", t: (key: string) => translations[key] ?? key }
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web", openLink: () => {} }) }))
const { persisted, Persist } = await import("../../src/utils/persist")

test("reasoning stays collapsed during heading changes and completion, then expands on demand", async () => {
  const [state, setState] = createStore({ text: "# First plan\nDetailed reasoning", streaming: true })
  const host = document.createElement("main")
  const dispose = render(
    () => (
      <I18nProvider value={language}>
        <ReasoningBlock text={state.text} streaming={state.streaming}>
          <p data-slot="full-reasoning">{state.text}</p>
        </ReasoningBlock>
      </I18nProvider>
    ),
    host,
  )
  try {
    const block = host.querySelector("details")!
    const summary = block.querySelector("summary")!
    expect(block.open).toBe(false)
    expect(host.querySelector("[data-slot=full-reasoning]")).toBeNull()
    setState("text", "# Changed heading\nLonger reasoning")
    expect(block.querySelector("summary")).toBe(summary)
    expect(summary.textContent).toContain("思考中")
    expect(summary.textContent).toContain("Changed heading")
    setState("streaming", false)
    expect(block.open).toBe(false)
    expect(summary.textContent).toContain("思考过程")
    expect(summary.getAttribute("style") ?? "").not.toMatch(/transform|animation/)
    summary.click()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(block.open).toBe(true)
    expect(host.querySelector("[data-slot=full-reasoning]")?.textContent).toContain("Longer reasoning")
  } finally {
    dispose()
  }
})

test("global project metadata renders immediately and survives a fresh persisted store", async () => {
  const project = { worktree: "/fixture/non-git", expanded: true }
  const metadata = { id: "global", worktree: "/", sandboxes: [], time: { created: 1, updated: 1 } }
  const key = "549-global-project-name"
  const first = createRoot((dispose) => {
    const [store, setStore, , ready] = persisted(
      Persist.global(key),
      createStore({ name: "", icon: { color: "blue" } }),
    )
    return { store, setStore, ready, dispose }
  })
  await first.ready.promise
  first.setStore("name", "My renamed workspace")
  const host = document.createElement("main")
  const dispose = render(() => <span>{enrichLocalProject(project, metadata, first.store, undefined).name}</span>, host)
  expect(host.textContent).toBe("My renamed workspace")
  dispose()
  first.dispose()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = createRoot((dispose) => {
    const [store, , , ready] = persisted(Persist.global(key), createStore({ name: "", icon: { color: "blue" } }))
    return { store, ready, dispose }
  })
  await second.ready.promise
  expect(enrichLocalProject(project, metadata, second.store, undefined).name).toBe("My renamed workspace")
  expect(
    enrichLocalProject(project, { ...metadata, id: "git-project", name: "Server name" }, second.store, undefined).name,
  ).toBe("Server name")
  second.dispose()
})

test("unsupported result exposes explicit native actions and never creates a download link or preview request", async () => {
  const calls: unknown[] = []
  const host = document.createElement("main")
  document.body.append(host)
  const dispose = render(
    () => (
      <ArtifactExternal
        target="report.docx"
        directory="/fixture"
        fileAction={async (input) => {
          calls.push(input)
        }}
      />
    ),
    host,
  )
  try {
    expect(artifactViewer("report.docx")).toBe("external")
    expect(artifactViewer("report.pdf")).toBe("pdf")
    expect(artifactViewer("result.html")).toBe("browser")
    expect(host.querySelector("a")).toBeNull()
    const buttons = host.querySelectorAll<HTMLButtonElement>("button")
    expect(buttons[0].textContent).toBe("用系统默认程序打开")
    buttons[0].click()
    await new Promise((resolve) => setTimeout(resolve, 10))
    buttons[1].click()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toEqual([
      { target: "report.docx", directory: "/fixture", action: "open" },
      { target: "report.docx", directory: "/fixture", action: "reveal" },
    ])
  } finally {
    dispose()
    host.remove()
  }
})

test("unavailable native host disables actions and rejected file access stays visible", async () => {
  const host = document.createElement("main")
  document.body.append(host)
  const missing = render(
    () => <ArtifactExternal target="report.docx" directory="/fixture" fileAction={undefined} />,
    host,
  )
  expect([...host.querySelectorAll("button")].every((button) => button.disabled)).toBe(true)
  expect(host.querySelector("[role=status]")).not.toBeNull()
  missing()
  const rejected = render(
    () => (
      <ArtifactExternal
        target="report.docx"
        directory="/fixture"
        fileAction={async () => {
          throw Error("denied")
        }}
      />
    ),
    host,
  )
  host.querySelector("button")!.click()
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(host.querySelector("[role=alert]")).not.toBeNull()
  rejected()
  host.remove()
})
