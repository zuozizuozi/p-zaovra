import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { ArtifactPreviewAPI } from "@/artifact-preview"

export function ArtifactExternal(props: {
  target: string
  directory: string
  fileAction: ArtifactPreviewAPI["fileAction"]
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ pending: false, error: "" })
  const perform = async (action: "open" | "reveal") => {
    if (state.pending || !props.fileAction) return
    setState({ pending: true, error: "" })
    await props
      .fileAction({ target: props.target, directory: props.directory, action })
      .catch(() => setState("error", language.t("artifact.externalError")))
      .finally(() => setState("pending", false))
  }
  return (
    <section
      data-component="artifact-external"
      class="flex h-full flex-col items-start justify-center gap-3 p-6 text-sm"
    >
      <strong class="max-w-full break-words">{props.target}</strong>
      <p class="text-text-weak">{language.t("artifact.externalFormat")}</p>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded-md border border-border-weak-base px-3 py-2"
          disabled={!props.fileAction || state.pending}
          onClick={() => void perform("open")}
        >
          {language.t("artifact.openDefault")}
        </button>
        <button
          type="button"
          class="rounded-md border border-border-weak-base px-3 py-2"
          disabled={!props.fileAction || state.pending}
          onClick={() => void perform("reveal")}
        >
          {language.t("artifact.reveal")}
        </button>
      </div>
      <Show when={!props.fileAction}>
        <p role="status" class="text-xs text-text-weak">
          {language.t("artifact.needDesktop")}
        </p>
      </Show>
      <Show when={state.error}>
        <p role="alert">{state.error}</p>
      </Show>
    </section>
  )
}
