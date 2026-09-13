import { createMemo, type Accessor } from "solid-js"
import { useGlobal } from "@/context/global"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/composer/session-request-tree"
import { ServerConnection } from "@/context/server"
import { hasUnfinishedShell } from "@/context/v2-session-adapter"

export function useSessionTabAvatarState(
  server: Accessor<ServerConnection.Key>,
  directory: Accessor<string>,
  sessionId: Accessor<string>,
) {
  const global = useGlobal()
  const notification = useNotification()
  const permission = usePermission()
  const permissionState = createMemo(() => permission.ensureServerState(server()))
  const connection = createMemo(() => global.servers.list().find((item) => ServerConnection.key(item) === server()))
  const sync = createMemo(() => {
    const conn = connection()
    if (conn) return global.ensureServerCtx(conn).sync
  })
  const hasPermissions = createMemo(() => {
    const serverSync = sync()
    if (!serverSync) return false
    const [store] = serverSync.child(directory(), { bootstrap: false })
    return !!sessionPermissionRequest(store.session, serverSync.session.data.permission, sessionId(), (item) => {
      return !permissionState().autoResponds(item, directory())
    })
  })
  const hasQuestions = createMemo(() => {
    const serverSync = sync()
    if (!serverSync) return false
    const [store] = serverSync.child(directory(), { bootstrap: false })
    return !!sessionQuestionRequest(store.session, serverSync.session.data.question, sessionId())
  })
  const needsAttention = createMemo(() => hasPermissions() || hasQuestions())
  const unfinished = createMemo(() => {
    const data = sync()?.session.data
    return !!data && hasUnfinishedShell(data.message[sessionId()] ?? [], data.part)
  })
  const unread = createMemo(
    () =>
      needsAttention() || unfinished() || notification.ensureServerState(server()).session.unseenCount(sessionId()) > 0,
  )
  const loading = createMemo(() => {
    const serverSync = sync()
    if (!serverSync) return false
    if (needsAttention()) return false
    return serverSync.session.data.session_working(sessionId())
  })
  const status = createMemo(() => {
    if (hasPermissions()) return "session.activity.permission" as const
    if (hasQuestions()) return "session.activity.question" as const
    if (loading()) return "session.activity.running" as const
    if (unfinished()) return "session.activity.shell" as const
    if (notification.ensureServerState(server()).session.unseenHasError(sessionId()))
      return "session.activity.error" as const
    if (unread()) return "session.activity.unread" as const
    return "session.activity.idle" as const
  })
  return { unread, loading, status }
}
