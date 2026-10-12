import { createEffect, createResource, onCleanup, onMount, Show, lazy, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { artifactViewer, type ArtifactState } from "@/artifact-preview"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { artifactPath } from "@/utils/artifact-path"
import { sourcePreviewNeedsBuild } from "@/utils/source-preview"

const PDF = lazy(() => import("./artifact-pdf"))
type Props = { target: string; directory: string; active?: boolean }
export function ArtifactView(props: Props) {
  const language = useLanguage()
  const platform = usePlatform()
  return (
    <Show when={artifactViewer(props.target) === "pdf"} fallback={<ArtifactBrowserView {...props} />}>
      <div class="flex h-full min-h-0 flex-col" aria-label={language.t("artifact.pdf")}>
        <div class="flex h-10 shrink-0 items-center justify-between border-b border-border-weak-base px-3 text-xs">
          <span class="min-w-0 truncate">{props.target}</span>
          <button
            class="h-10 shrink-0 px-2"
            onClick={() => {
              const target = /^(?:[A-Za-z]:[\\/]|\/)/.test(props.target)
                ? props.target
                : `${props.directory}/${props.target}`
              if (/^https?:/.test(props.target)) platform.openLink(props.target)
              else void platform.openPath?.(target)
            }}
          >
            {language.t("artifact.external")}
          </button>
        </div>
        <Suspense fallback={<p class="p-3 text-xs">{language.t("artifact.loadingPdf")}</p>}>
          <PDF
            load={() => {
              if (!platform.artifactPreview?.readPDF) return Promise.reject(new Error("PDF viewer requires desktop"))
              return platform.artifactPreview.readPDF({ target: props.target, directory: props.directory })
            }}
          />
        </Suspense>
      </div>
    </Show>
  )
}
function ArtifactBrowserView(props: Props) {
  const sdk = useSDK()
  const language = useLanguage()
  const [needsBuild] = createResource(
    () => {
      const path = artifactPath(props.target, props.directory)?.path
      return path && /\.html?$/i.test(path) ? path : undefined
    },
    async (path) => {
      const result = await Promise.allSettled([
        sdk().client.file.read({ path }),
        sdk().client.file.read({
          path: `${path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : ""}package.json`,
        }),
      ])
      return sourcePreviewNeedsBuild(
        path,
        result[0].status === "fulfilled" ? (result[0].value.data?.content ?? "") : "",
        result[1].status === "fulfilled" ? (result[1].value.data?.content ?? "") : "",
      )
    },
  )
  const platform = usePlatform()
  const dialog = useDialog()
  const api = platform.artifactPreview
  const id = crypto.randomUUID()
  const [state, setState] = createStore<ArtifactState>({ title: props.target, url: "", loading: true, zoom: 1 })
  let host: HTMLDivElement | undefined
  let disposed = false
  let ready = false
  let lastBounds = ""
  const update = () => {
    if (!api || !host || !ready || disposed) return
    const rect = host.getBoundingClientRect()
    const obscured =
      dialog.active ||
      Array.from(document.querySelectorAll('[role="dialog"], [role="menu"]')).some(
        (node) => node.getClientRects().length > 0,
      )
    const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    const visible =
      props.active !== false && !obscured && rect.width > 0 && rect.height > 0 && !host.closest("[inert], [hidden]")
    const next = JSON.stringify({ bounds, visible })
    if (next === lastBounds) return
    lastBounds = next
    void api.bounds({ id, bounds, visible }).catch(() => setState("error", language.t("artifact.boundsError")))
  }
  const open = async () => {
    if (!api) {
      setState({ loading: false, error: language.t("artifact.needDesktop") })
      return
    }
    try {
      await api.open({ id, target: props.target, directory: props.directory })
      if (disposed) {
        await api.action({ id, action: "close" })
        return
      }
      ready = true
      lastBounds = ""
      update()
    } catch (error) {
      if (!disposed) setState({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const action = (action: "reload" | "zoom-in" | "zoom-out" | "reset") => {
    if (!ready) {
      void open()
      return
    }
    void api?.action({ id, action }).catch(() => setState("error", language.t("artifact.actionError")))
  }
  createEffect(() => {
    dialog.active
    props.active
    update()
  })
  onMount(() => {
    void open()
    const resize = new ResizeObserver(update)
    if (host) resize.observe(host)
    const observer = new MutationObserver(update)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "inert"],
    })
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    const timer = setInterval(() => {
      if (!api || !ready || disposed) return
      void api
        .state(id)
        .then((value) => {
          if (value && !disposed) setState(value)
        })
        .catch(() => undefined)
    }, 600)
    onCleanup(() => {
      clearInterval(timer)
      observer.disconnect()
      resize.disconnect()
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    })
  })
  onCleanup(() => {
    disposed = true
    void api?.action({ id, action: "close" }).catch(() => undefined)
  })
  const button =
    "h-10 shrink-0 rounded-md px-2 text-xs hover:bg-background-stronger focus-visible:outline-2 focus-visible:outline-border-active disabled:opacity-40"
  return (
    <section class="flex h-full min-h-0 flex-col bg-background-base" aria-label={language.t("artifact.preview")}>
      <div class="flex shrink-0 items-center gap-1 border-b border-border-weak-base px-2">
        <button class={button} onClick={() => action("reload")}>
          {language.t("artifact.refresh")}
        </button>
        <span class="min-w-0 flex-1 truncate text-xs text-text-weak" title={state.url || props.target}>
          {props.target}
        </span>
        <button class={button} aria-label={language.t("artifact.zoomOut")} onClick={() => action("zoom-out")}>
          −
        </button>
        <button class={button} aria-label={language.t("artifact.zoomReset")} onClick={() => action("reset")}>
          {Math.round(state.zoom * 100)}%
        </button>
        <button class={button} aria-label={language.t("artifact.zoomIn")} onClick={() => action("zoom-in")}>
          ＋
        </button>
        <button
          class={button}
          disabled={!state.url}
          onClick={() => {
            if (/^https?:\/\//i.test(props.target)) {
              platform.openLink(state.url)
              return
            }
            const path = /^(?:[A-Za-z]:[\\/]|\/)/.test(props.target)
              ? props.target
              : `${props.directory}/${props.target}`
            void platform.openPath?.(path).catch(() => setState("error", language.t("artifact.externalError")))
          }}
        >
          {language.t("artifact.external")}
        </button>
      </div>
      <Show when={state.loading}>
        <div role="status" class="shrink-0 px-3 py-2 text-xs text-text-weak">
          {language.t("artifact.loading")}
        </div>
      </Show>
      <Show when={needsBuild()}>
        <p role="status" class="shrink-0 px-3 py-2 text-xs text-text-weak">
          {language.t("artifact.sourceBuild")}
        </p>
      </Show>
      <Show when={state.error}>
        <div role="alert" class="shrink-0 break-words px-3 py-2 text-xs text-text-weak">
          {state.error}
        </div>
      </Show>
      <div ref={host} class="m-2 min-h-0 flex-1" data-component="artifact-surface" />
    </section>
  )
}
