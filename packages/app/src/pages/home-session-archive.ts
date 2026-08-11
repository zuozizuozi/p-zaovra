import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import type { ServerConnection } from "@/context/server"

type HomeSession = {
  id: string
  directory: string
}

type SessionUpdate = {
  sessionID: string
  archived: boolean
}

export async function archiveHomeSession(input: {
  server: ServerConnection.Key
  session: HomeSession
  update: (value: SessionUpdate) => Promise<unknown>
  remove: () => void
  onError?: (error: unknown) => void
}) {
  await input
    .update({
      sessionID: input.session.id,
      archived: true,
    })
    .then(() => {
      input.remove()
      notifySessionTabsRemoved({
        server: input.server,
        directory: input.session.directory,
        sessionIDs: [input.session.id],
      })
    })
    .catch((error) => input.onError?.(error))
}
