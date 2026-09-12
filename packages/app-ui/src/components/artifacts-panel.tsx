import { Persist, persisted } from "@/utils/persist"
import { useSessionLayout } from "@/pages/session/session-layout"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ArtifactView } from "@/components/artifact-view"
import { useSDK } from "@/context/sdk"

export function ArtifactsPanel(props: { active: boolean }) {
  const sdk = useSDK()
  const { sessionKey } = useSessionLayout()
  const [state, setState] = persisted(
    Persist.window(`artifacts:${sessionKey()}`),
    createStore({ input: "", targets: [] as string[], active: "" }),
  )
  const open = () => {
    const target = state.input.trim()
    if (!target) return
    setState({
      targets: [...state.targets.filter((item) => item !== target), target].slice(-8),
      active: target,
      input: "",
    })
  }
  const close = (target: string) => {
    const targets = state.targets.filter((item) => item !== target)
    setState({ targets, active: state.active === target ? (targets.at(-1) ?? "") : state.active })
  }
  return (
    <div class="flex h-full min-h-0 flex-col bg-background-base" aria-label="成果面板">
      <form
        class="flex shrink-0 gap-2 border-b border-border-weak-base p-3"
        onSubmit={(event) => {
          event.preventDefault()
          open()
        }}
      >
        <input
          class="h-10 min-w-0 flex-1 rounded-md border border-border-weak-base bg-transparent px-3 text-sm outline-none focus:border-border-active"
          aria-label="成果地址或项目文件"
          placeholder="网站地址，或项目文件（如 demo.html）"
          value={state.input}
          onInput={(event) => setState("input", event.currentTarget.value)}
        />
        <button
          type="submit"
          class="h-10 shrink-0 rounded-md bg-background-stronger px-3 text-sm disabled:opacity-40"
          disabled={!state.input.trim()}
        >
          打开
        </button>
      </form>
      <Show when={state.targets.length > 0}>
        <div
          class="flex shrink-0 overflow-x-auto border-b border-border-weak-base"
          role="tablist"
          aria-label="已打开的成果"
        >
          <For each={state.targets}>
            {(target) => (
              <div class="flex shrink-0 items-center" classList={{ "bg-background-stronger": state.active === target }}>
                <button
                  role="tab"
                  aria-selected={state.active === target}
                  class="h-10 max-w-48 truncate px-3 text-xs"
                  title={target}
                  onClick={() => setState("active", target)}
                >
                  {target.split(/[\\/]/).filter(Boolean).at(-1) || target}
                </button>
                <button
                  class="h-10 w-10 shrink-0 text-text-weak hover:text-text-strong"
                  aria-label={`关闭 ${target}`}
                  onClick={() => close(target)}
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show
        when={state.active}
        fallback={
          <div class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-text-weak">
            <strong class="text-base text-text-strong">在这里查看成果</strong>
            <p class="max-w-72 text-sm">打开网页、HTML 演示、图片或 PDF。项目里的代码和图片也可以从“打开文件”查看。</p>
            <p class="max-w-72 text-xs">网站项目需先运行开发服务，再填入它的本机地址。</p>
          </div>
        }
      >
        <Show when={props.active && state.active} keyed>
          {(target) => <ArtifactView target={target} directory={sdk().directory} />}
        </Show>
      </Show>
    </div>
  )
}
