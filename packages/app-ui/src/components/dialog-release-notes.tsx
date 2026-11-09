import { formatVersion } from "@/updater"
import { For, onCleanup, onMount } from "solid-js"
import type { ReleaseHighlight } from "@/release-notes"
import { Dialog } from "@zaovra-ai/ui/dialog"
import { Button } from "@zaovra-ai/ui/button"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import "./dialog-release-notes.css"

export function DialogReleaseNotes(props: { version: string; highlights: ReleaseHighlight[] }) {
  const dialog = useDialog()
  const language = useLanguage()
  const settings = useSettings()

  function handleDisable() {
    settings.general.setReleaseNotes(false)
    dialog.close()
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" && event.key !== "Enter") return
    if (
      event.key === "Enter" &&
      event.target instanceof HTMLButtonElement &&
      event.target.closest("[data-release-notes]")
    )
      return
    event.preventDefault()
    event.stopPropagation()
    dialog.close()
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown, true)
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown, true))
  })

  return (
    <Dialog
      title={language.t("dialog.releaseNotes.title", { version: formatVersion(props.version) })}
      fit
      class="dialog-release-notes"
    >
      <div class="flex flex-col min-h-0 outline-none" data-release-notes tabIndex={-1} autofocus>
        <ul
          class="m-0 flex flex-col gap-5 px-5 pb-2 list-none overflow-y-auto min-h-0"
          data-release-notes-list
          tabIndex={0}
        >
          <For each={props.highlights}>
            {(feature) => (
              <li class="flex flex-col gap-1.5">
                <h2 class="m-0 text-14-medium text-text-strong">{feature.title}</h2>
                <p class="m-0 text-14-regular text-text-base leading-relaxed">{feature.description}</p>
              </li>
            )}
          </For>
        </ul>
        <div class="flex items-center justify-between gap-4 px-5 pt-5 pb-5 shrink-0" data-release-notes-actions>
          <Button variant="ghost" size="small" onClick={handleDisable}>
            {language.t("dialog.releaseNotes.action.hideFuture")}
          </Button>
          <Button variant="primary" size="large" onClick={() => dialog.close()}>
            {language.t("dialog.releaseNotes.action.getStarted")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
