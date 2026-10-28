import { onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { useServerSync } from "@/context/server-sync"
import type { FeedbackRequest } from "@/feedback"
import { useSettingsDialog } from "./settings-dialog"

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
    const last = messages.findLast((message) => message.role === "assistant")
    const parts = messages.slice(-50).flatMap((message) => sync().session.data.part[message.id] ?? [])
    input.context = {
      provider: last?.providerID,
      model: last?.modelID,
      events: parts.flatMap((part) =>
        part.type !== "tool"
          ? []
          : [
              {
                at:
                  part.state.status === "completed" || part.state.status === "error"
                    ? part.state.time.end
                    : part.state.status === "running"
                      ? part.state.time.start
                      : 0,
                kind: part.tool,
                state: part.state.status,
              },
            ],
      ),
      errors: parts.flatMap((part) =>
        part.type === "tool" && part.state.status === "error" ? [{ at: part.state.time.end, category: "unknown" }] : [],
      ),
    }
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
