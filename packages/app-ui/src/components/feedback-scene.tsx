import { onCleanup } from "solid-js"
import { useParams } from "@solidjs/router"
import { useServerSync } from "@/context/server-sync"
import type { FeedbackRequest } from "@/feedback"
import { useSettingsDialog } from "./settings-dialog"
import { sessionFeedback } from "./feedback-session"
import { useServerSDK } from "@/context/server-sdk"
import { listV2Sessions } from "@/context/v2-session-list"

export function FeedbackScene() {
  const params = useParams()
  const sync = useServerSync()
  const sdk = useServerSDK()
  const configure = useSettingsDialog("providers")
  const collect = (event: Event) => {
    const input = (event as CustomEvent<FeedbackRequest>).detail
    input.configure = configure
    const scene = (id?: string) => {
      if (!id) return { context: {}, error: undefined, readConversation: undefined }
      const messages = sync().session.data.message[id] ?? []
      const diagnostics = sessionFeedback(messages, (id) => sync().session.data.part[id] ?? [], Date.now())
      return {
        context: { ...diagnostics.context, sessionID: id },
        error: diagnostics.error,
        // Conversation text is read only after the chosen inclusion policy.
        readConversation: () =>
          (sync().session.data.message[id] ?? [])
            .slice(-20)
            .flatMap((message) =>
              (sync().session.data.part[message.id] ?? []).flatMap((part) =>
                part.type === "text"
                  ? [`${new Date(message.time.created).toISOString()} ${message.role}: ${part.text}`]
                  : [],
              ),
            )
            .join("\n")
            .slice(0, 32_000),
      }
    }
    const current = scene(params.id)
    input.context = { ...input.context, ...current.context }
    input.error ??= current.error
    input.readConversation = current.readConversation
    input.sessionID = params.id
    input.sessions = Object.values(sync().session.data.info).flatMap((session) =>
      session ? [{ id: session.id, title: session.title }] : [],
    )
    input.loadSessions = async () =>
      (await listV2Sessions(sdk().client, { limit: 100, order: "desc" })).data
        .filter((session) => !session.time.archived)
        .map((session) => ({ id: session.id, title: session.title }))
    input.selectSession = async (id) => {
      if (id) await sync().session.sync(id, { messageLimit: 50 })
      return scene(id)
    }
  }
  window.addEventListener("zaovra:feedback-scene", collect)
  onCleanup(() => window.removeEventListener("zaovra:feedback-scene", collect))
  return null
}
