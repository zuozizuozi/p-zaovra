import { expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { PromptActions } from "../../src/components/prompt-input/actions"

test("Stop remains available with a draft and never submits or clears it", () => {
  const [state, setState] = createStore({ working: true, draft: "Keep this draft" })
  const calls = { stops: 0, sends: 0 }
  const host = document.createElement("main")
  document.body.append(host)
  const dispose = render(
    () => (
      <form
        onSubmit={(event) => {
          event.preventDefault()
          calls.sends++
        }}
      >
        <PromptActions
          working={state.working}
          blank={!state.draft}
          shell={false}
          stopLabel="Stop"
          sendLabel="Send"
          escapeLabel="Esc"
          onStop={() => calls.stops++}
        />
      </form>
    ),
    host,
  )
  try {
    expect(host.querySelectorAll('[aria-label="Stop"]')).toHaveLength(1)
    expect(host.querySelectorAll('[aria-label="Send"]')).toHaveLength(1)
    host.querySelector<HTMLButtonElement>('[aria-label="Stop"]')!.click()
    expect(calls).toEqual({ stops: 1, sends: 0 })
    expect(state.draft).toBe("Keep this draft")
    host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.click()
    expect(calls).toEqual({ stops: 1, sends: 1 })
    setState("draft", "")
    expect(host.querySelectorAll('[aria-label="Stop"]')).toHaveLength(1)
    expect(host.querySelector('[aria-label="Send"]')).toBeNull()
    host.querySelector<HTMLButtonElement>('[aria-label="Stop"]')!.click()
    expect(calls).toEqual({ stops: 2, sends: 1 })
    setState("working", false)
    expect(host.querySelector('[aria-label="Stop"]')).toBeNull()
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.disabled).toBe(true)
    setState("draft", "Next task")
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!.disabled).toBe(false)
  } finally {
    dispose()
    host.remove()
  }
})

test("a nonempty attachment submission and shell mode keep independent Stop and Send actions", () => {
  const host = document.createElement("main")
  const [state, setState] = createStore({ working: true, blank: false, shell: false })
  const dispose = render(
    () => (
      <PromptActions
        working={state.working}
        blank={state.blank}
        shell={state.shell}
        tabIndex={-1}
        stopLabel="停止"
        sendLabel="发送"
        escapeLabel="Esc"
        onStop={() => {}}
      />
    ),
    host,
  )
  try {
    expect(host.querySelector('[aria-label="停止"]')?.getAttribute("type")).toBe("button")
    expect(host.querySelector('[aria-label="发送"]')?.getAttribute("type")).toBe("submit")
    expect(host.querySelector('[aria-label="发送"]')?.getAttribute("data-icon")).toBe("arrow-up")
    setState("shell", true)
    expect(host.querySelector('[aria-label="发送"]')?.getAttribute("data-icon")).toBe("arrow-undo-down")
    expect(host.querySelector<HTMLButtonElement>('[aria-label="停止"]')?.tabIndex).toBe(-1)
  } finally {
    dispose()
  }
})
