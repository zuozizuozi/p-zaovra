import { createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@zaovra-ai/ui/context"
import { usePlatform } from "@/context/platform"
import { persisted } from "@/utils/persist"

export const { use: useHighlights, provider: HighlightsProvider } = createSimpleContext({
  name: "Highlights",
  gate: false,
  init: () => {
    const platform = usePlatform()
    const [store, setStore, , ready] = persisted("highlights.v1", createStore<{ version?: string }>({}))
    const markSeen = () => {
      if (platform.version) setStore("version", platform.version)
    }

    // Release highlights stay closed until there is meaningful, versioned content.
    createEffect(() => {
      if (!ready() || !platform.version || store.version === platform.version) return
      markSeen()
    })

    return {
      ready,
      from: () => undefined,
      to: () => undefined,
      get last() {
        return store.version
      },
      markSeen,
    }
  },
})
