import { createEffect, createResource, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist"
import worker from "pdfjs-dist/build/pdf.worker.min.mjs?url"

GlobalWorkerOptions.workerSrc = worker

export default function ArtifactPDF(props: { load: () => Promise<ArrayBuffer> }) {
  const [state, setState] = createStore({ page: 1, zoom: 1, width: 600, error: "" })
  let host: HTMLDivElement | undefined
  let canvas: HTMLCanvasElement | undefined
  let disposed = false
  const tasks: ReturnType<typeof getDocument>[] = []
  const [pdf] = createResource(async () => {
    try {
      const bytes = await props.load()
      if (disposed) return
      const base = new URL(`${import.meta.env.BASE_URL}pdfjs/`, window.location.href).href
      const task = getDocument({
        data: new Uint8Array(bytes),
        cMapUrl: `${base}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${base}standard_fonts/`,
        wasmUrl: `${base}wasm/`,
      })
      tasks.push(task)
      return await task.promise
    } catch {
      setState("error", "无法读取 PDF，文件可能损坏或需要密码")
      return
    }
  })
  onCleanup(() => {
    disposed = true
    tasks.forEach((task) => void task.destroy())
  })
  onMount(() => {
    const resize = new ResizeObserver(() => {
      if (host) setState("width", Math.max(160, host.clientWidth - 32))
    })
    if (host) resize.observe(host)
    onCleanup(() => resize.disconnect())
  })
  createEffect(() => {
    const document = pdf()
    const page = state.page
    const width = state.width
    const zoom = state.zoom
    if (!document || !canvas) return
    let cancelled = false
    let render: ReturnType<Awaited<ReturnType<typeof document.getPage>>["render"]> | undefined
    void document
      .getPage(page)
      .then((page) => {
        if (cancelled || !canvas) return
        const original = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: (width / original.width) * zoom })
        const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(12000000 / (viewport.width * viewport.height)))
        canvas.width = Math.ceil(viewport.width * ratio)
        canvas.height = Math.ceil(viewport.height * ratio)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        render = page.render({ canvas, viewport, transform: [ratio, 0, 0, ratio, 0, 0] })
        return render.promise.then(() => {
          if (!cancelled && canvas) canvas.dataset.rendered = String(state.page)
        })
      })
      .catch(() => {
        if (!cancelled) setState("error", "此页渲染失败，请尝试其他页或外部打开")
      })
    onCleanup(() => {
      cancelled = true
      render?.cancel()
    })
  })
  const button = "h-10 shrink-0 rounded-md px-2 text-xs hover:bg-background-stronger disabled:opacity-40"
  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 flex-wrap items-center justify-center gap-1 border-b border-border-weak-base">
        <button class={button} disabled={state.page <= 1} onClick={() => setState("page", state.page - 1)}>
          上一页
        </button>
        <span class="px-2 text-xs" aria-label="PDF 页码">
          {state.page} / {pdf()?.numPages ?? "—"}
        </span>
        <button
          class={button}
          disabled={!pdf() || state.page >= pdf()!.numPages}
          onClick={() => setState("page", state.page + 1)}
        >
          下一页
        </button>
        <button
          class={button}
          disabled={state.zoom <= 0.5}
          onClick={() => setState("zoom", Math.max(0.5, state.zoom - 0.25))}
        >
          缩小
        </button>
        <button class={button} onClick={() => setState("zoom", 1)}>
          适合宽度
        </button>
        <button
          class={button}
          disabled={state.zoom >= 2}
          onClick={() => setState("zoom", Math.min(2, state.zoom + 0.25))}
        >
          放大
        </button>
      </div>
      <Show when={pdf.loading}>
        <p role="status" class="p-3 text-xs text-text-weak">
          正在读取 PDF…
        </p>
      </Show>
      <Show when={state.error || pdf.error}>
        <p role="alert" class="p-3 text-xs text-text-weak">
          {state.error || "无法读取 PDF，请检查文件路径"}
        </p>
      </Show>
      <div ref={host} class="min-h-0 flex-1 overflow-auto p-4">
        <canvas ref={canvas} class="block bg-white" aria-label="PDF 页面" />
      </div>
    </div>
  )
}
