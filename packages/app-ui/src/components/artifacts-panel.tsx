import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createEffect, createSignal, For, on, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { ArtifactView } from "@/components/artifact-view"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useFileLink } from "@zaovra-ai/session-ui/context/file-link"
import { collectArtifactFiles } from "@/utils/artifact-files"
import { useFile } from "@/context/file"
import { artifactLines } from "@/utils/artifact-lines"

export function ArtifactsPanel(props: { active: boolean; target?: { path: string } }) {
  const language = useLanguage()
  let panel: HTMLDivElement | undefined
  const sdk = useSDK()
  const sync = useSync()
  const file = useFile()
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
    createStore({ input: "", targets: [] as string[], active: "", split: 30 }),
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
    <div
      ref={panel}
      data-component="artifacts-panel"
      class="flex h-full min-h-0 flex-col bg-background-base"
      aria-label={language.t("artifact.panel")}
    >
      <form
        class="flex shrink-0 gap-2 border-b border-border-weak-base p-3"
        onSubmit={(event) => {
          event.preventDefault()
          open()
        }}
      >
        <input
          class="h-10 min-w-0 flex-1 rounded-md border border-border-weak-base bg-transparent px-3 text-sm outline-none focus:border-border-active"
          aria-label={language.t("artifact.address")}
          placeholder={language.t("artifact.placeholder")}
          value={state.input}
          onInput={(event) => setState("input", event.currentTarget.value)}
        />
        <button
          type="submit"
          class="h-10 shrink-0 rounded-md bg-background-stronger px-3 text-sm disabled:opacity-40"
          disabled={!state.input.trim()}
        >
          {language.t("artifact.open")}
        </button>
      </form>
      <div
        class="flex min-h-24 shrink-0 flex-col overflow-hidden border-b border-border-weak-base p-3"
        style={{ height: `${state.split ?? 30}%`, "max-height": "60%" }}
      >
        <div class="flex items-center justify-between text-xs">
          <strong>{language.t("artifact.files")}</strong>
          <button type="button" disabled={loading()} onClick={() => void refresh()}>
            {loading() ? language.t("artifact.refreshing") : language.t("artifact.refreshFiles")}
          </button>
        </div>
        <div class="mt-2 min-h-0 flex-1 overflow-auto">
          <For each={inventory()?.files}>
            {(path) => (
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="block w-full truncate py-1 text-left text-xs hover:underline"
                  title={path}
                  onClick={() => openFile?.(path)}
                >
                  {path}
                  <Show when={baseline() && !baseline()!.has(path)}>
                    <span class="ml-2 text-text-weak">{language.t("artifact.observed")}</span>
                  </Show>
                </button>
                <details
                  class="shrink-0 text-xs"
                  onToggle={(event) => {
                    if (event.currentTarget.open) void file.load(path)
                  }}
                >
                  <summary class="cursor-pointer">{language.t("artifact.details")}</summary>
                  <Show when={file.get(path)?.error}>
                    <span role="alert">{language.t("artifact.unreadable")}</span>
                    <button type="button" onClick={() => void file.load(path, { force: true })}>
                      {language.t("artifact.retry")}
                    </button>
                  </Show>
                  <Show when={file.get(path)?.loading}>
                    <span>{language.t("artifact.reading")}</span>
                  </Show>
                  <Show when={!file.get(path)?.error && !file.get(path)?.loading && file.get(path)?.content}>
                    {(content) => (
                      <span>
                        {artifactLines(content()) === undefined
                          ? language.t("artifact.binary")
                          : language.t("artifact.lines", { count: artifactLines(content()) ?? 0 })}
                      </span>
                    )}
                  </Show>
                </details>
              </div>
            )}
          </For>
          <Show when={inventory() && !inventory()!.files.length}>
            <p class="text-xs text-text-weak">{language.t("artifact.empty")}</p>
          </Show>
        </div>
        <Show when={inventory()?.limited}>
          <p class="mt-2 text-xs text-text-weak">{language.t("artifact.limited")}</p>
        </Show>
        <Show when={inventory()?.errors.length}>
          <p role="alert" class="mt-2 text-xs text-text-weak">
            {language.t("artifact.partial")}
          </p>
        </Show>
      </div>
      <button
        type="button"
        role="separator"
        aria-orientation="horizontal"
        aria-label={language.t("artifact.resize")}
        aria-valuemin={15}
        aria-valuemax={60}
        aria-valuenow={state.split ?? 30}
        class="h-2 shrink-0 cursor-row-resize bg-background-stronger touch-none focus-visible:outline-2 focus-visible:outline-border-active"
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId) || !panel) return
          const bounds = panel.getBoundingClientRect()
          setState("split", Math.max(15, Math.min(60, ((event.clientY - bounds.top - 64) / bounds.height) * 100)))
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
          event.preventDefault()
          setState("split", Math.max(15, Math.min(60, (state.split ?? 30) + (event.key === "ArrowUp" ? -5 : 5))))
        }}
      />
      <Show when={state.targets.length > 0}>
        <div
          class="flex shrink-0 overflow-x-auto border-b border-border-weak-base"
          role="tablist"
          aria-label={language.t("artifact.tabs")}
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
                  aria-label={language.t("artifact.close", { target })}
                  onClick={() => close(target)}
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="min-h-0 flex-1 overflow-hidden">
        <Show
          when={state.active}
          fallback={
            <div class="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-text-weak">
              <strong class="text-base text-text-strong">{language.t("artifact.here")}</strong>
              <p class="max-w-72 text-sm">{language.t("artifact.hint")}</p>
              <p class="max-w-72 text-xs">{language.t("artifact.serverHint")}</p>
            </div>
          }
        >
          <Show when={props.active && state.active} keyed>
            {(target) => <ArtifactView target={target} directory={sdk().directory} />}
          </Show>
        </Show>
      </div>
    </div>
  )
}
