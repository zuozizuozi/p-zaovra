import { createEffect, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useData } from "../context"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { useI18n } from "@zaovra-ai/ui/context/i18n"
import { ImagePreview } from "@zaovra-ai/ui/image-preview"

export function BrowserScreenshot(props: {
  sessionID?: string
  screenshot: { mime?: string; reference?: string; data?: string }
}) {
  const data = useData()
  const dialog = useDialog()
  const i18n = useI18n()
  const [state, setState] = createStore({ src: undefined as string | undefined, status: "loading", attempt: 0 })
  createEffect(() => {
    state.attempt
    const source = data.screenshotSource
    const value = props.screenshot
    const sessionID = props.sessionID
    const abort = new AbortController()
    onCleanup(() => abort.abort())
    setState({ src: undefined, status: "loading" })
    const accept = (value: { mime?: string; data?: string }) => {
      if (abort.signal.aborted) return
      if (value.mime !== "image/png" || typeof value.data !== "string" || value.data.length > 6 * 1024 * 1024) {
        setState("status", "failed")
        return
      }
      setState({ src: `data:image/png;base64,${value.data}`, status: "ready" })
    }
    if (value.reference && source && sessionID) {
      void source.read(sessionID, value.reference, abort.signal).then(accept, () => {
        if (!abort.signal.aborted) setState("status", "failed")
      })
      return
    }
    accept(value)
  })
  return (
    <div data-component="browser-screenshot">
      <Show when={state.status === "loading"}>
        <span role="status">{i18n.t("ui.browserScreenshot.loading")}</span>
      </Show>
      <Show when={state.status === "failed"}>
        <span role="status">{i18n.t("ui.browserScreenshot.unavailable")}</span>
        <button type="button" onClick={() => setState("attempt", (value) => value + 1)}>
          {i18n.t("ui.browserScreenshot.retry")}
        </button>
      </Show>
      <Show when={state.src}>
        <button
          type="button"
          class="max-w-full"
          aria-label={i18n.t("ui.browserScreenshot.preview")}
          onClick={() =>
            dialog.show(() => <ImagePreview src={state.src ?? ""} alt={i18n.t("ui.browserScreenshot.preview")} />)
          }
        >
          <img
            src={state.src}
            alt={i18n.t("ui.browserScreenshot.preview")}
            style={{ "max-width": "min(320px, 100%)", "max-height": "180px", "object-fit": "contain" }}
            onError={() => setState({ src: undefined, status: "failed" })}
          />
        </button>
      </Show>
    </div>
  )
}
