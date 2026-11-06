import { createEffect, createMemo, createResource, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@zaovra-ai/ui/context"
import { useDialog } from "@zaovra-ai/ui/context/dialog"
import { DialogReleaseNotes } from "@/components/dialog-release-notes"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { StartupContext } from "@/context/startup"
import { releaseNotes, shouldShowReleaseNotes } from "@/release-notes"
import { persisted } from "@/utils/persist"

export const { use: useHighlights, provider: HighlightsProvider } = createSimpleContext({
  name: "Highlights",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const settings = useSettings()
    const language = useLanguage()
    const dialog = useDialog()
    const startup = useContext(StartupContext)
    const [started] = createResource(async () => {
      await startup
      return true
    })
    const [store, setStore, , ready] = persisted(
      { key: "highlights.v1", sync: true },
      createStore<{ version?: string }>({}),
    )
    const [state, setState] = createStore({ checked: false })
    const notes = createMemo(() => releaseNotes(platform.version, language.locale()))
    const markSeen = () => {
      if (platform.version) setStore("version", platform.version)
    }
    const show = () => {
      if (!notes().length || !platform.version) return
      void dialog.push(() => <DialogReleaseNotes version={platform.version!} highlights={notes()} />)
    }

    createEffect(() => {
      if (!ready() || !settings.ready() || !started() || state.checked || !platform.version) return
      const display = shouldShowReleaseNotes(
        store.version,
        platform.version,
        settings.general.releaseNotes(),
        notes().length,
      )
      // Wait for an existing form to close instead of replacing it with update notes.
      if (display && dialog.active) return
      setState("checked", true)
      // Record fresh installs and disabled/missing notes too, so toggling the setting cannot replay an old update.
      markSeen()
      if (display) show()
    })

    return {
      ready,
      available: () => notes().length > 0,
      show,
      get last() {
        return store.version
      },
      markSeen,
    }
  },
})
