import { Persist, persisted } from "@/utils/persist"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createEffect, createSignal, For, on, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { ArtifactView } from "@/components/artifact-view"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useFileLink } from "@zaovra-ai/session-ui/context/file-link"
import { collectArtifactFiles } from "@/utils/artifact-files"

export function ArtifactsPanel(props: { active: boolean; target?: { path: string } }) {
  const sdk = useSDK()
  const sync = useSync()
  const openFile = useFileLink()
  const { sessionKey, params } = useSessionLayout()
  const [inventory, setInventory] = createSignal<Awaited<ReturnType<typeof collectArtifactFiles>>>()
  const [loading, setLoading] = createSignal(false)
  const [baseline, setBaseline] = createSignal<Set<string>>()
  let scannedAt = 0
  let generation = 0
  const running = () => !!params.id && (sync().data.session_status[params.id]?.type ?? "idle") !== "idle"
  const refresh = async () => {
    const token = ++generation
    const client = sdk().client
    setLoading(true)
    const result = await collectArtifactFiles((path) =>
      client.file.list({ path }).then((response) => response.data ?? []),
    )
    if (token !== generation) return
    setInventory(result)
    scannedAt = Date.now()
    setLoading(false)
  }
  onCleanup(() => {
    generation += 1
  })
  let watcherRefresh: ReturnType<typeof setTimeout> | undefined
  const unsubscribe = sdk().event.listen((event) => {
    if (event.details.type !== "file.watcher.updated" || !props.active) return
    clearTimeout(watcherRefresh)
    watcherRefresh = setTimeout(() => void refresh(), 300)
  })
  onCleanup(() => {
    unsubscribe()
    clearTimeout(watcherRefresh)
  })
  createEffect(
    on(
      () => props.active,
      (active) => {
        if (active) void refresh()
      },
    ),
  )
  createEffect(
    on(running, (active, previous) => {
      if (active) {
        const previousFiles = untrack(inventory)
        const message = sync()
          .data.message[params.id ?? ""]?.filter((message) => message.role === "user")
          .at(-1)
        // Only a complete scan finished before admission can establish an honest before-task baseline.
        setBaseline(
          previous === false &&
            previousFiles &&
            !previousFiles.limited &&
            !previousFiles.errors.length &&
            message &&
            scannedAt < message.time.created
            ? new Set(previousFiles.files)
            : undefined,
        )
      }
      if (!active && previous) void refresh()
    }),
  )
  const [state, setState] = persisted(
    Persist.window(`artifacts:${sessionKey()}`),
    createStore({ input: "", targets: [] as string[], active: "" }),
  )
  const open = () => {
    const target = state.input.trim()
    if (!target) return
    if (!/^https?:\/\//i.test(target) && openFile) {
      openFile(target)
      setState("input", "")
      return
    }
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
  createEffect(() => {
    const target = props.target?.path
    if (!target) return
    setState("targets", (items) => [...items.filter((item) => item !== target), target].slice(-8))
    setState("active", target)
  })
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
      <div class="shrink-0 border-b border-border-weak-base p-3">
        <div class="flex items-center justify-between text-xs">
          <strong>项目文件</strong>
          <button type="button" disabled={loading()} onClick={() => void refresh()}>
            {loading() ? "正在刷新…" : "刷新文件"}
          </button>
        </div>
        <div class="mt-2 max-h-40 overflow-auto">
          <For each={inventory()?.files}>
            {(path) => (
              <button
                type="button"
                class="block w-full truncate py-1 text-left text-xs hover:underline"
                title={path}
                onClick={() => openFile?.(path)}
              >
                {path}
                <Show when={baseline() && !baseline()!.has(path)}>
                  <span class="ml-2 text-text-weak">本次观察到新增</span>
                </Show>
              </button>
            )}
          </For>
          <Show when={inventory() && !inventory()!.files.length}>
            <p class="text-xs text-text-weak">当前范围内没有文件。</p>
          </Show>
        </div>
        <Show when={inventory()?.limited}>
          <p class="mt-2 text-xs text-text-weak">已达浏览上限：3层目录、40个目录或500个文件。可输入具体路径打开。</p>
        </Show>
        <Show when={inventory()?.errors.length}>
          <p role="alert" class="mt-2 text-xs text-text-weak">
            部分目录无法读取，请刷新重试。
          </p>
        </Show>
      </div>
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
