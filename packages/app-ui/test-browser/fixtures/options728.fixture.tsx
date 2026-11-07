import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { PlatformProvider } from "../../src/context/platform"
import { LanguageProvider } from "../../src/context/language"
import { customSlashCommands } from "../../src/components/prompt-input/custom-slash-commands"
import { recentStartSessions, SessionStartOptions } from "../../src/components/session/session-start-options"
import {
  PromptInputV2,
  type PromptInputV2PersistedState,
  type PromptInputV2Suggestion,
} from "@zaovra-ai/session-ui/v2/prompt-input"
import { createPromptInputV2Controller } from "@zaovra-ai/session-ui/v2/prompt-input/interaction"
import type { CommandView, Session } from "@zaovra-ai/sdk/v2/client"

test("728 source-tagged CommandView records render skill/MCP groups without submitting", async () => {
  const commands = customSlashCommands(
    [
      {
        name: "inspect-project",
        source: "skill",
        description: "Read the project using an installed skill",
        template: "Inspect",
        hints: [],
        agent: "build",
      },
      {
        name: "local-docs",
        source: "mcp",
        description: "Search connected local documentation",
        template: "Docs",
        hints: [],
        agent: "build",
      },
    ] as CommandView[],
    (name) => "Run " + name,
  )
  const suggestions: PromptInputV2Suggestion[] = commands.map((item) => ({
    id: item.id,
    kind: "command",
    group: item.source === "skill" ? "skill" : "mcp",
    label: "/" + item.trigger,
    trigger: item.trigger,
    description: item.description,
  }))
  const [state, setState] = createStore<PromptInputV2PersistedState>({ prompt: [], cursor: 0, context: { items: [] } })
  let sent = 0
  const owned = createRoot((dispose) => ({
    dispose,
    controller: createPromptInputV2Controller({
      store: [state, setState],
      commands: () => suggestions,
      context: () => [],
      searchContextFiles: () => [],
      view: { submit: { stopping: () => false, onSubmit: () => sent++, onStop() {} } },
    }),
  }))
  const root = document.createElement("div")
  document.body.append(root)
  const dispose = render(
    () => (
      <PromptInputV2
        controller={owned.controller}
        suggestionLabels={{ empty: "无匹配", search: "命令", builtin: "内置", skill: "技能", mcp: "MCP" }}
      />
    ),
    root,
  )
  try {
    owned.controller.dispatch({ type: "commands.open" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect([...root.querySelectorAll('[data-slot="command-group"]')].map((item) => item.textContent)).toEqual([
      "技能",
      "MCP",
    ])
    expect(root.textContent).toContain("Read the project using an installed skill")
    expect(root.textContent).toContain("Search connected local documentation")
    root.querySelector<HTMLButtonElement>('[data-suggestion-id="custom.mcp.local-docs"]')!.click()
    expect(state.prompt.map((part) => ("content" in part ? part.content : "")).join("")).toContain("/local-docs")
    expect(sent).toBe(0)
  } finally {
    dispose()
    root.remove()
    owned.dispose()
  }
})

test("728 new-session production selector renders five newest actual root sessions and opens each identity", () => {
  const sessions = Array.from({ length: 8 }, (_, index) => ({
    id: "recent728-" + index,
    title: "Actual recent " + index,
    directory: "F:/synthetic728",
    time: { created: 1, updated: index + 2 },
  })) as Session[]
  const archived = { ...sessions[7], id: "archived", time: { ...sessions[7].time, updated: 100, archived: 101 } }
  const child = { ...sessions[7], id: "child", parentID: sessions[0].id, time: { created: 1, updated: 102 } }
  const original = [sessions[0], archived, ...sessions.slice(1), child]
  const recent = recentStartSessions(original)
  expect(recent.map((item) => item.id)).toEqual([7, 6, 5, 4, 3].map((index) => "recent728-" + index))
  expect(original[0]).toBe(sessions[0])
  const opened: string[] = []
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
        <LanguageProvider locale="zh">
          <SessionStartOptions
            recent={recent}
            disabled={false}
            onRetry={() => {}}
            onOpen={(session) => opened.push(session.id)}
            onSuggest={() => {}}
          />
        </LanguageProvider>
      </PlatformProvider>
    ),
    root,
  )
  try {
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-session-id]")]
    expect(buttons).toHaveLength(5)
    buttons.forEach((button) => button.click())
    expect(opened).toEqual(recent.map((session) => session.id))
    expect(root.textContent).not.toContain("Actual recent 2")
  } finally {
    dispose()
    root.remove()
  }
})
