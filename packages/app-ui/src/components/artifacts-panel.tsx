import { createArtifactAction } from "@/utils/artifact-action"
import { showToast } from "@/utils/toast"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createEffect, createSignal, For, on, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { ArtifactView, type ArtifactControls } from "@/components/artifact-view"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useFileLink } from "@zaovra-ai/session-ui/context/file-link"
import { collectArtifactFiles } from "@/utils/artifact-files"
import { useFile } from "@/context/file"
import { artifactLines } from "@/utils/artifact-lines"
import { MenuV2 } from "@zaovra-ai/ui/v2/menu-v2"
import { usePlatform } from "@/context/platform"
import { Icon } from "@zaovra-ai/ui/icon"

export function ArtifactsPanel(props: { active: boolean; target?: { path: string }; onReview?: () => void }) {
  const language = useLanguage()
  const platform = usePlatform()
  const reveal = createArtifactAction(platform, () => showToast({ title: language.t("artifact.externalError") }))
  const [controls, setControls] = createStore<{ current?: ArtifactControls }>({})
  let panel: HTMLDivElement | undefined
  const sdk = useSDK()
  const sync = useSync()
  const file = useFile()
  const openFile = useFileLink()
  const { sessionKey, params, view } = useSessionLayout()
  const [inventory, setInventory] = createSignal<Awaited<ReturnType<typeof collectArtifactFiles>>>()
  const [loading, setLoading] = createSignal(false)
  const [baseline, setBaseline] = createSignal<Set<string>>()
  const [drawer, setDrawer] = createStore({ open: false, filter: "" })
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
    createStore({
      input: "",
      targets: [] as string[],
      active: "",
      split: undefined as number | undefined,
      maximized: false,
    }),
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
      input: target,
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
    setState({ active: target, input: target })
  })
  return (
    <div
      ref={panel}
      data-component="artifacts-panel"
      class="flex h-full min-h-0 flex-col bg-background-base"
      classList={{ "!fixed inset-0 !h-auto z-50": props.active && state.maximized }}
      aria-label={language.t("artifact.panel")}
    >
      <div data-slot="artifact-tabs-row" class="flex h-10 shrink-0 items-center border-b border-border-weak-base px-2">
        <button type="button" class="shrink-0 px-2 text-xs" onClick={props.onReview}>
          {language.t("session.tab.review")}
        </button>
        <div class="flex min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label={language.t("artifact.tabs")}>
          <Show when={!state.targets.length}>
            <span class="px-2 text-xs">{language.t("artifact.panel")}</span>
          </Show>
          <For each={state.targets}>
            {(target) => (
              <div class="flex min-w-0 shrink-0 items-center">
                <button
                  role="tab"
                  aria-selected={state.active === target}
                  class="h-9 max-w-40 truncate rounded-lg px-2 text-xs"
                  classList={{ "bg-background-stronger": state.active === target }}
                  title={target}
                  onClick={() => setState({ active: target, input: target })}
                >
                  {target.split(/[\\/]/).filter(Boolean).at(-1) || target}
                </button>
                <button
                  type="button"
                  class="size-7 shrink-0"
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
          class="size-8 shrink-0"
          onClick={() => setState("maximized", !state.maximized)}
          aria-label={language.t(state.maximized ? "artifact.restore" : "artifact.maximize")}
          title={language.t(state.maximized ? "artifact.restore" : "artifact.maximize")}
        >
          <Icon name={state.maximized ? "collapse" : "expand"} />
        </button>
        <button
          type="button"
          class="size-8 shrink-0"
          onClick={() => view().reviewPanel.close()}
          aria-label={language.t("common.close")}
          title={language.t("common.close")}
        >
          <Icon name="close" />
        </button>
      </div>
      <form
        data-slot="artifact-address-row"
        class="flex h-11 shrink-0 items-center gap-1 border-b border-border-weak-base px-2"
        onSubmit={(event) => {
          event.preventDefault()
          open()
        }}
      >
        <button
          type="button"
          class="size-8 shrink-0"
          disabled={!controls.current}
          onClick={() => controls.current?.reload()}
          aria-label={language.t("artifact.refresh")}
          title={language.t("artifact.refresh")}
        >
          <Icon name="reset" />
        </button>
        <input
          class="h-8 min-w-0 flex-1 rounded-full border border-border-weak-base bg-transparent px-3 text-xs outline-none focus:border-border-active"
          aria-label={language.t("artifact.address")}
          placeholder={language.t("artifact.address")}
          value={state.input}
          onInput={(event) => setState("input", event.currentTarget.value)}
        />
        <button
          type="submit"
          class="size-8 shrink-0"
          disabled={!state.input.trim()}
          aria-label={language.t("artifact.open")}
          title={language.t("artifact.open")}
        >
          <Icon name="arrow-right" />
        </button>
        <button
          type="button"
          class="size-8 shrink-0"
          aria-label={language.t("artifact.files")}
          title={language.t("artifact.files")}
          aria-expanded={drawer.open}
          onClick={() => setDrawer("open", !drawer.open)}
        >
          <Icon name="folder" />
        </button>
        <button
          type="button"
          class="size-8 shrink-0"
          disabled={!state.active}
          aria-label={language.t(/^https?:\/\//i.test(state.active) ? "artifact.external" : "artifact.reveal")}
          title={language.t(/^https?:\/\//i.test(state.active) ? "artifact.external" : "artifact.reveal")}
          onClick={() => void reveal(state.active, sdk().directory)}
        >
          <Icon name="square-arrow-top-right" />
        </button>
        <MenuV2>
          <MenuV2.Trigger
            class="size-8 shrink-0"
            aria-label={language.t("common.moreOptions")}
            title={language.t("common.moreOptions")}
          >
            ···
          </MenuV2.Trigger>
          <MenuV2.Portal>
            <MenuV2.Content>
              <For
                each={
                  [
                    { action: "zoom-out", key: "artifact.zoomOut" },
                    { action: "reset", key: "artifact.zoomReset" },
                    { action: "zoom-in", key: "artifact.zoomIn" },
                  ] as const
                }
              >
                {(item) => (
                  <MenuV2.Item disabled={!controls.current} onSelect={() => controls.current?.zoom(item.action)}>
                    {language.t(item.key)} {item.action === "reset" ? `${controls.current?.percent ?? 100}%` : ""}
                  </MenuV2.Item>
                )}
              </For>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </form>
      <Show when={drawer.open}>
        <div
          class="flex min-h-36 shrink-0 flex-col overflow-hidden border-b border-border-weak-base p-3"
          style={{ height: `${state.split ?? 20}%`, "max-height": "60%" }}
        >
          <div class="flex items-center justify-between text-xs">
            <strong>{language.t("artifact.files")}</strong>
            <button type="button" disabled={loading()} onClick={() => void refresh()}>
              {loading() ? language.t("artifact.refreshing") : language.t("artifact.refreshFiles")}
            </button>
          </div>
          <div class="mt-2 min-h-0 flex-1 overflow-auto">
            <input
              class="mb-2 w-full rounded-md border border-border-weak-base bg-transparent px-2 py-1 text-xs"
              value={drawer.filter}
              onInput={(event) => setDrawer("filter", event.currentTarget.value)}
              aria-label={language.t("artifact.filter")}
              placeholder={language.t("artifact.filter")}
            />
            <For
              each={inventory()?.files.filter((path) =>
                path.toLocaleLowerCase().includes(drawer.filter.toLocaleLowerCase()),
              )}
            >
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
          aria-valuenow={state.split ?? 20}
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
            setState("split", Math.max(15, Math.min(60, (state.split ?? 20) + (event.key === "ArrowUp" ? -5 : 5))))
          }}
        />
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
            {(target) => (
              <ArtifactView
                target={target}
                directory={sdk().directory}
                compact
                onControls={(current) => setControls("current", current)}
              />
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}
