import { onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { useServerSync } from "@/context/server-sync"
import type { FeedbackRequest } from "@/feedback"
import { useSettingsDialog } from "./settings-dialog"
import { sessionFeedback } from "./feedback-session"

export function FeedbackScene() {
  const params = useParams()
  const sync = useServerSync()
  const configure = useSettingsDialog("providers")
  const collect = (event: Event) => {
    if (!params.id) return
    const input = (event as CustomEvent<FeedbackRequest>).detail
    input.configure = configure
    const id = params.id
    const messages = sync().session.data.message[id] ?? []
    const diagnostics = sessionFeedback(messages, (id) => sync().session.data.part[id] ?? [], Date.now())
    input.context = diagnostics.context
    input.error ??= diagnostics.error
    // No transcript text or tool arguments are read until the user opts in.
    input.readConversation = () =>
      (sync().session.data.message[id] ?? [])
        .slice(-20)
        .flatMap((message) =>
          (sync().session.data.part[message.id] ?? []).flatMap((part) =>
            part.type === "text" ? [`${message.role}: ${part.text}`] : [],
          ),
        )
        .join("\n")
        .slice(0, 32_000)
  }
  window.addEventListener("zaovra:feedback-scene", collect)
  onCleanup(() => window.removeEventListener("zaovra:feedback-scene", collect))
  return null
}
