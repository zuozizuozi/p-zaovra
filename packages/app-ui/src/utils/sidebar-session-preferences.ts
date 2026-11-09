import type { ServerConnection } from "@/context/server"
import { sortSidebarItems } from "./sidebar-order"

export type PinnedSession = { server: ServerConnection.Key; sessionID: string; directory: string }

export function createPinnedSessions(input: { read: () => PinnedSession[]; write: (items: PinnedSession[]) => void }) {
  const has = (server: ServerConnection.Key, id: string) =>
    input.read().some((item) => item.server === server && item.sessionID === id)
  const remove = (server: ServerConnection.Key, id: string) =>
    input.write(input.read().filter((item) => item.server !== server || item.sessionID !== id))
  return {
    list: input.read,
    has,
    remove,
    reorder(keys: string[]) {
      input.write(sortSidebarItems(input.read(), keys, (item) => `${item.server}:${item.sessionID}`))
    },
    toggle(server: ServerConnection.Key, session: { id: string; directory: string }) {
      if (has(server, session.id)) return remove(server, session.id)
      input.write([...input.read(), { server, sessionID: session.id, directory: session.directory }])
    },
  }
}

export function createUnreadMarker(input: {
  read: () => Record<string, string | undefined>
  write: (session: string, directory: string | undefined) => void
}) {
  return {
    count: (session: string, notifications: number) => Math.max(notifications, input.read()[session] ? 1 : 0),
    markUnread: (session: string, directory: string) => input.write(session, directory),
    markViewed: (session: string) => input.write(session, undefined),
  }
}
