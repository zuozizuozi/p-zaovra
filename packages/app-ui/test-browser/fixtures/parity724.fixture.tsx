import { expect, test } from "bun:test"
import { createRoot, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { PlatformProvider } from "../../src/context/platform"
import { LanguageProvider } from "../../src/context/language"
import { SettingsProvider, useSettings } from "../../src/context/settings"
import { ConversationViewSelect } from "../../src/components/conversation-view-select"
import { SessionTodoDock } from "../../src/pages/session/composer/session-todo-dock"
import { SessionStartOptions } from "../../src/components/session/session-start-options"
import {
  PromptInputV2,
  type PromptInputV2PersistedState,
  type PromptInputV2Suggestion,
} from "@zaovra-ai/session-ui/v2/prompt-input"
import { createPromptInputV2Controller } from "@zaovra-ai/session-ui/v2/prompt-input/interaction"
import type { Session } from "@zaovra-ai/sdk/v2"
import type { ConversationView } from "../../src/utils/conversation-view"

function mount(locale: "en" | "zh", children: () => JSX.Element) {
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
        <LanguageProvider locale={locale}>{children()}</LanguageProvider>
      </PlatformProvider>
    ),
    root,
  )
  return {
    root,
    close: () => {
      dispose()
      root.remove()
    },
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test.each(["en", "zh"] as const)(
  "724 %s todo summary expands and retains every item across deliveries",
  async (locale) => {
    const [state, setState] = createStore({ delivered: false, key: "session-a:turn1" })
    const view = mount(locale, () => (
      <SessionTodoDock
        todos={[{ content: "One retained item", status: "completed", priority: "high" }]}
        collapsed={false}
        onToggle={() => {}}
        collapseLabel="Collapse"
        expandLabel="Expand"
        dockProgress={1}
        delivered={state.delivered}
        deliveryKey={state.key}
      />
    ))
    try {
      await tick()
      expect(view.root.querySelector('[aria-expanded="true"]')).not.toBeNull()
      setState("delivered", true)
      expect(view.root.textContent).toContain(locale === "zh" ? "已完成 1 项" : "Completed: 1")
      expect(view.root.querySelector('[aria-expanded="false"]')).not.toBeNull()
      expect(view.root.textContent).toContain("One retained item")
      ;(view.root.querySelector('[data-action="session-todo-toggle"]') as HTMLElement).click()
      expect(view.root.querySelector('[aria-expanded="true"]')).not.toBeNull()
      setState("key", "session-a:turn2")
      expect(view.root.querySelector('[aria-expanded="false"]')).not.toBeNull()
      setState("delivered", false)
      expect(view.root.querySelector('[aria-expanded="true"]')).not.toBeNull()
    } finally {
      view.close()
    }
  },
)

test.each(["en", "zh"] as const)(
  "724 %s start options only render supplied recent sessions and never auto-send",
  async (locale) => {
    const [state, setState] = createStore({ disabled: false, recent: [] as Session[] })
    const selected: string[] = []
    const opened: string[] = []
    const view = mount(locale, () => (
      <SessionStartOptions
        recent={state.recent}
        disabled={state.disabled}
        onRetry={() => {}}
        onOpen={(session) => opened.push(session.id)}
        onSuggest={(text) => selected.push(text)}
      />
    ))
    try {
      await tick()
      expect(view.root.querySelectorAll("li")).toHaveLength(0)
      expect(view.root.querySelectorAll("button")).toHaveLength(3)
      ;(view.root.querySelector("button") as HTMLButtonElement).click()
      expect(selected).toHaveLength(1)
      expect(selected[0]).toContain(locale === "zh" ? "项目" : "project")
      setState("disabled", true)
      ;(view.root.querySelector("button") as HTMLButtonElement).click()
      expect(selected).toHaveLength(1)
      setState(
        "recent",
        Array.from(
          { length: 5 },
          (_, index) =>
            ({
              id: "session-" + index,
              title: "Real session " + index,
              directory: "/fixture",
              time: { created: index, updated: index },
            }) as Session,
        ),
      )
      expect(view.root.querySelectorAll("li")).toHaveLength(5)
      ;(view.root.querySelector('[data-session-id="session-2"]') as HTMLButtonElement).click()
      expect(opened).toEqual(["session-2"])
    } finally {
      view.close()
    }
  },
)

test("724 settings presets update existing display flags while temporary selection leaves defaults intact", async () => {
  const [state, setState] = createStore({ temporary: undefined as ConversationView | undefined })
  let settings!: ReturnType<typeof useSettings>
  function Controls() {
    settings = useSettings()
    return (
      <>
        <ConversationViewSelect
          value={settings.general.conversationView()}
          onChange={(value) => value && settings.general.setConversationView(value)}
        />
        <ConversationViewSelect
          temporary
          value={state.temporary ?? "default"}
          onChange={(value) => setState("temporary", value)}
        />
      </>
    )
  }
  const view = mount("zh", () => (
    <SettingsProvider>
      <Controls />
    </SettingsProvider>
  ))
  try {
    await tick()
    settings.general.setConversationView("detailed")
    expect(settings.general.showReasoningSummaries()).toBe(true)
    expect(settings.general.shellToolPartsExpanded()).toBe(true)
    expect(settings.general.editToolPartsExpanded()).toBe(true)
    const temporaryTrigger = view.root.querySelectorAll<HTMLElement>('[data-component="select-v2"]')[1]
    temporaryTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await tick()
    const normal = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
      item.textContent?.includes("普通"),
    )
    expect(normal).toBeDefined()
    normal!.click()
    await tick()
    expect(state.temporary).toBe("normal")
    expect(settings.general.conversationView()).toBe("detailed")
    expect(view.root.textContent).toContain("普通")
    expect(view.root.textContent).toContain("详细")
    setState("temporary", undefined)
    expect(view.root.textContent).toContain("跟随默认")
    settings.general.setConversationView("thinking")
    expect(settings.general.showReasoningSummaries()).toBe(true)
    expect(settings.general.shellToolPartsExpanded()).toBe(false)
  } finally {
    view.close()
  }
})

test("724 actual slash controller groups duplicate triggers by source, filters descriptions and follows visual keyboard order", async () => {
  let submitted = 0
  const [state, setState] = createStore<PromptInputV2PersistedState>({ prompt: [], cursor: 0, context: { items: [] } })
  const commands: PromptInputV2Suggestion[] = [
    { id: "mcp.same", kind: "command", group: "mcp", label: "/same", trigger: "same", description: "MCP lookup" },
    {
      id: "builtin.new",
      kind: "command",
      group: "builtin",
      label: "/new",
      trigger: "new",
      description: "New conversation",
    },
    { id: "skill.same", kind: "command", group: "skill", label: "/same", trigger: "same", description: "Skill lookup" },
  ]
  const owned = createRoot((dispose) => ({
    dispose,
    controller: createPromptInputV2Controller({
      store: [state, setState],
      commands: () => commands,
      context: () => [],
      searchContextFiles: () => [],
      view: { submit: { stopping: () => false, onSubmit: () => submitted++, onStop() {} } },
    }),
  }))
  const view = mount("zh", () => (
    <PromptInputV2
      controller={owned.controller}
      suggestionLabels={{ empty: "无匹配", search: "命令", builtin: "内置命令", skill: "技能", mcp: "MCP" }}
    />
  ))
  try {
    owned.controller.dispatch({ type: "commands.open" })
    await tick()
    expect(owned.controller.suggestions().map((item) => item.id)).toEqual(["builtin.new", "skill.same", "mcp.same"])
    expect([...view.root.querySelectorAll('[data-slot="command-group"]')].map((item) => item.textContent)).toEqual([
      "内置命令",
      "技能",
      "MCP",
    ])
    owned.controller.onKeyDown(new KeyboardEvent("keydown", { key: "ArrowDown" }))
    expect(owned.controller.state.popover.type === "closed" ? undefined : owned.controller.state.popover.activeID).toBe(
      "skill.same",
    )
    owned.controller.dispatch({ type: "popover.query", value: "lookup" })
    await tick()
    expect(owned.controller.suggestions().map((item) => item.id)).toEqual(["skill.same", "mcp.same"])
    ;(view.root.querySelector('[data-suggestion-id="mcp.same"]') as HTMLButtonElement).click()
    expect(state.prompt.map((part) => ("content" in part ? part.content : "")).join("")).toContain("/same")
    expect(submitted).toBe(0)
  } finally {
    view.close()
    owned.dispose()
  }
})
