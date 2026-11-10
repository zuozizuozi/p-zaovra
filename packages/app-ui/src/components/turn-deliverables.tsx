import { createMemo, createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@zaovra-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { artifactPreviewable } from "@/utils/artifact-path"
import { inspectTurnDeliverables, type TurnDeliverable } from "@/utils/turn-deliverables"

export function TurnDeliverables(props: {
  items: TurnDeliverable[]
  directory: string
  onPreview: (target: string) => void
  onOpenFile: (target: string) => void
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const sdk = useSDK()
  const [state, setState] = createStore({ pending: "", error: "", saved: "" })
  const inspect = async (target: string) => {
    const directory = props.directory
    if (platform.artifactPreview?.inspectFile) return platform.artifactPreview.inspectFile({ target, directory })
    const parent = target.includes("/") ? target.slice(0, target.lastIndexOf("/")) : ""
    // Exact-parent lookup distinguishes missing files from valid zero-byte files without scanning the workspace.
    const entries = await sdk().client.file.list({ path: parent })
    if (!entries.data?.some((entry) => entry.type === "file" && entry.path.replaceAll("\\", "/") === target))
      throw new Error(language.t("artifact.delivery.unavailable"))
    return undefined
  }
  const [availability, { refetch }] = createResource(
    () => ({ directory: props.directory, items: props.items }),
    async (input) => ({ ...input, files: await inspectTurnDeliverables(input.items, inspect) }),
  )
  // Do not carry a previous turn's file verification into a new turn or directory.
  const files = () => {
    const value = availability()
    return value?.directory === props.directory && value.items === props.items ? value.files : undefined
  }
  const items = createMemo(() => props.items.filter((item) => item.after === undefined || files()?.[item.target]))
  const perform = async (item: TurnDeliverable, action: "preview" | "open" | "save") => {
    if (state.pending) return
    setState({ pending: item.target, error: "", saved: "" })
    const directory = props.directory
    try {
      if (item.kind === "link") {
        if (action === "preview") props.onPreview(item.target)
        if (action === "open") platform.openLink(item.target)
        return
      }
      await inspect(item.target)
      if (action === "preview") return props.onPreview(item.target)
      if (action === "open") {
        if (!platform.artifactPreview?.fileAction) return props.onOpenFile(item.target)
        return await platform.artifactPreview.fileAction({ target: item.target, directory, action: "open" })
      }
      const saved = await platform.artifactPreview?.saveFile?.({ target: item.target, directory })
      if (saved) setState("saved", saved.path)
    } catch (error) {
      setState("error", error instanceof Error ? error.message : language.t("artifact.delivery.failed"))
      void refetch()
    } finally {
      setState("pending", "")
    }
  }
  return (
    <Show when={items().length}>
      <section
        data-component="turn-deliverables"
        aria-label={language.t("artifact.delivery.title")}
        class="mb-3 max-h-60 w-[calc(100%-24px)] max-w-200 shrink-0 self-center overflow-auto rounded-xl border border-border-weak-base bg-background-base p-3 text-xs"
      >
        <strong class="block pb-2 text-text-strong">{language.t("artifact.delivery.title")}</strong>
        <Show when={items().some((item) => item.kind === "file") && !platform.artifactPreview?.saveFile}>
          <p class="pb-2 text-text-weak">{language.t("artifact.delivery.desktopActions")}</p>
        </Show>
        <ul class="flex flex-col gap-2">
          <For each={items()}>
            {(item) => {
              const unavailable = () => item.kind === "file" && files()?.[item.target] !== true
              return (
                <li class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-background-weak px-3 py-2">
                  <Icon name={item.kind === "link" ? "square-arrow-top-right" : "open-file"} />
                  <div class="min-w-0 flex-1 basis-32">
                    <span class="block break-all font-medium text-text-strong">{item.target}</span>
                    <Show when={item.kind === "file" && unavailable()}>
                      <span role="status" class="text-text-weak">
                        {availability.loading
                          ? language.t("artifact.delivery.checking")
                          : language.t("artifact.delivery.unavailable")}
                      </span>
                    </Show>
                  </div>
                  <div class="flex shrink-0 flex-wrap items-center gap-1">
                    <Show when={item.kind === "link" || artifactPreviewable(item.target)}>
                      <button
                        type="button"
                        class="min-h-11 rounded-md px-2 enabled:hover:bg-background-stronger disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-border-active"
                        disabled={unavailable() || !!state.pending || !platform.artifactPreview?.open}
                        title={
                          !platform.artifactPreview?.open ? language.t("artifact.delivery.desktopActions") : undefined
                        }
                        onClick={() => void perform(item, "preview")}
                      >
                        {language.t("artifact.preview")}
                      </button>
                    </Show>
                    <button
                      type="button"
                      class="min-h-11 rounded-md px-2 enabled:hover:bg-background-stronger disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-border-active"
                      disabled={unavailable() || !!state.pending}
                      onClick={() => void perform(item, "open")}
                    >
                      {language.t(item.kind === "link" ? "artifact.external" : "artifact.open")}
                    </button>
                    <Show when={item.kind === "file"}>
                      <button
                        type="button"
                        class="min-h-11 rounded-md px-2 enabled:hover:bg-background-stronger disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-border-active"
                        disabled={unavailable() || !!state.pending || !platform.artifactPreview?.saveFile}
                        title={
                          !platform.artifactPreview?.saveFile
                            ? language.t("artifact.delivery.desktopActions")
                            : undefined
                        }
                        onClick={() => void perform(item, "save")}
                      >
                        {language.t("artifact.delivery.save")}
                      </button>
                    </Show>
                    <Show when={item.kind === "file" && unavailable() && !availability.loading}>
                      <button type="button" class="min-h-10 px-2 underline" onClick={() => void refetch()}>
                        {language.t("artifact.retry")}
                      </button>
                    </Show>
                  </div>
                </li>
              )
            }}
          </For>
        </ul>
        <Show when={state.error}>
          <p role="alert" class="pt-2 text-text-strong">
            {state.error}
          </p>
        </Show>
        <Show when={state.saved}>
          <p role="status" class="break-all pt-2 text-text-weak">
            {language.t("artifact.delivery.saved", { path: state.saved })}
          </p>
        </Show>
      </section>
    </Show>
  )
}
