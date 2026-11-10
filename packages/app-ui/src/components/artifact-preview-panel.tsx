import { createEffect, For, on, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@zaovra-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { Persist, persisted } from "@/utils/persist"
import { useSessionLayout } from "@/pages/session/session-layout"
import { ArtifactView } from "./artifact-view"
import { useFileLink } from "@zaovra-ai/session-ui/context/file-link"

// A preview of explicitly opened results. File discovery belongs to the file browser.
export function ArtifactPreviewPanel(props: { active: boolean; target?: { path: string; request: string } }) {
  const language = useLanguage()
  const sdk = useSDK()
  const openFile = useFileLink()
  const { sessionKey, tabs, view } = useSessionLayout()
  const [state, setState, , ready] = persisted(
    Persist.window(`artifacts:${sessionKey()}`),
    createStore({ targets: [] as string[], active: "", request: "", input: "", maximized: false }),
  )
  createEffect(
    on(
      () => [ready(), props.target] as const,
      ([loaded, target]) => {
        if (!loaded) return
        if (target && target.request !== untrack(() => state.request)) {
          setState({
            targets: [...untrack(() => state.targets).filter((item) => item !== target.path), target.path].slice(-8),
            active: target.path,
            input: target.path,
            request: target.request,
          })
          return
        }
        // Retire persisted empty tabs left by the old scan entry instead of rendering an unreachable view.
        if (!untrack(() => state.targets.length && state.active)) tabs().close("artifacts")
      },
    ),
  )
  const close = (target: string) => {
    const targets = state.targets.filter((item) => item !== target)
    const active = state.active === target ? (targets.at(-1) ?? "") : state.active
    setState({ targets, active, input: state.active === target ? active : state.input })
    if (!targets.length) {
      tabs().close("artifacts")
      view().reviewPanel.close()
    }
  }
  return (
    <section
      data-component="artifact-preview-panel"
      class="flex h-full min-h-0 flex-col bg-background-base"
      classList={{ "!fixed inset-0 !h-auto z-50": props.active && state.maximized }}
      aria-label={language.t("artifact.preview")}
    >
      <div
        data-slot="artifact-tabs-row"
        class="flex min-h-10 shrink-0 items-center gap-1 border-b border-border-weak-base px-2"
      >
        <div role="tablist" aria-label={language.t("artifact.tabs")} class="flex min-w-0 flex-1 overflow-x-auto">
          <For each={state.targets}>
            {(target) => (
              <div class="flex shrink-0 items-center">
                <button
                  type="button"
                  role="tab"
                  aria-selected={state.active === target}
                  title={target}
                  class="min-h-10 max-w-48 truncate rounded-md px-2 text-xs"
                  classList={{ "bg-background-stronger": state.active === target }}
                  onClick={() => setState({ active: target, input: target })}
                >
                  {target.split(/[\\/]/).filter(Boolean).at(-1) || target}
                </button>
                <button
                  type="button"
                  class="flex size-10 items-center justify-center"
                  aria-label={language.t("artifact.close", { target })}
                  onClick={() => close(target)}
                >
                  <Icon name="close-small" />
                </button>
              </div>
            )}
          </For>
        </div>
        <button
          type="button"
          class="flex size-10 shrink-0 items-center justify-center"
          aria-label={language.t(state.maximized ? "artifact.restore" : "artifact.maximize")}
          title={language.t(state.maximized ? "artifact.restore" : "artifact.maximize")}
          onClick={() => setState("maximized", !state.maximized)}
        >
          <Icon name={state.maximized ? "collapse" : "expand"} />
        </button>
        <button
          type="button"
          class="flex size-10 shrink-0 items-center justify-center"
          aria-label={language.t("common.close")}
          onClick={() => view().reviewPanel.close()}
        >
          <Icon name="close" />
        </button>
      </div>
      <form
        data-slot="artifact-address-row"
        class="flex min-h-11 shrink-0 items-center gap-1 border-b border-border-weak-base px-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (state.input.trim()) openFile?.(state.input.trim())
        }}
      >
        <input
          class="h-9 min-w-0 flex-1 rounded-md border border-border-weak-base bg-transparent px-3 text-xs outline-none focus:border-border-active"
          aria-label={language.t("artifact.address")}
          value={state.input}
          onInput={(event) => setState("input", event.currentTarget.value)}
        />
        <button
          type="submit"
          class="min-h-10 shrink-0 rounded-md px-3 text-xs"
          disabled={!state.input.trim() || !openFile}
        >
          {language.t("artifact.open")}
        </button>
      </form>
      <div class="min-h-0 flex-1 overflow-hidden">
        <Show when={props.active && state.active} keyed>
          {(target) => <ArtifactView target={target} directory={sdk().directory} />}
        </Show>
      </div>
    </section>
  )
}
