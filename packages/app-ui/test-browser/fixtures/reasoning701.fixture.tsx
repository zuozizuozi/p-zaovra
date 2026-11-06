import { expect, test } from "bun:test"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { LanguageProvider } from "../../src/context/language"
import { ReasoningControl } from "../../src/components/reasoning-control"
import { PlatformProvider } from "../../src/context/platform"

test("701 reasoning slider skips unsupported levels and disappears for plain models", async () => {
  const [state, setState] = createStore({ level: "high" as string | undefined, reasoning: true })
  const selected: Array<string | undefined> = []
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
        <LanguageProvider locale="en">
          <ReasoningControl
            model={{
              current: () => ({ capabilities: { reasoning: state.reasoning } }),
              variant: {
                list: () => (state.reasoning ? ["low", "high", "max"] : []),
                current: () => state.level,
                set: (value) => {
                  selected.push(value)
                  setState("level", value)
                },
              },
            }}
          />
        </LanguageProvider>
      </PlatformProvider>
    ),
    root,
  )
  try {
    await Promise.resolve()
    const range = root.querySelector("input[type=range]") as HTMLInputElement
    expect(range).not.toBeNull()
    const medium = [...root.querySelectorAll("button")].find((button) => button.textContent === "Medium")
    expect(medium?.disabled).toBe(true)
    range.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))
    expect(state.level).toBe("low")
    range.value = "2"
    range.dispatchEvent(new Event("input", { bubbles: true }))
    expect(selected).not.toContain("medium")
    range.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
    expect(state.level).toBe("max")
    range.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
    expect(state.level).toBeUndefined()
    setState("reasoning", false)
    expect(root.querySelector("input[type=range]")).toBeNull()
  } finally {
    dispose()
    root.remove()
  }
})
