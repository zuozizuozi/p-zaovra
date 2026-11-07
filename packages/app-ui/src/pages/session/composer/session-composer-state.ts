import { createEffect, createMemo, on, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionView, QuestionView, Todo } from "@zaovra-ai/sdk/v2"
import { useLocation, useParams } from "@solidjs/router"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"
import { todoDeliveryComplete } from "./todo-delivery"

export function createSessionComposerController() {
  const params = useParams()
  const location = useLocation()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const language = useLanguage()
  const permission = usePermission()

  const questionRequest = createMemo((): QuestionView | undefined => {
    const requested = new URLSearchParams(location.hash.slice(1)).get("question")
    return (
      sync().data.question[params.id ?? ""]?.find((item) => item.id === requested) ??
      sessionQuestionRequest(sync().data.session, sync().data.question, params.id)
    )
  })

  const permissionRequest = createMemo((): PermissionView | undefined => {
    const requested = new URLSearchParams(location.hash.slice(1)).get("permission")
    const target = sync().data.permission[params.id ?? ""]?.find((item) => item.id === requested)
    if (target && !permission.autoResponds(target, sdk().directory)) return target
    return sessionPermissionRequest(sync().data.session, sync().data.permission, params.id, (item) => {
      return !permission.autoResponds(item, sdk().directory)
    })
  })

  createEffect(
    on(
      () => {
        const request = permissionRequest()
        return request ? permission.autoReplyError(request) : undefined
      },
      (error) => {
        if (error)
          showToast({ title: language.t("common.requestFailed"), description: formatServerError(error, language.t) })
      },
    ),
  )

  const blocked = createMemo(() => {
    const id = params.id
    if (!id) return false
    return !!permissionRequest() || !!questionRequest()
  })

  const todos = createMemo((): Todo[] => {
    const id = params.id
    if (!id) return []
    return serverSync().session.data.todo[id] ?? []
  })

  const live = createMemo(() => sync().data.session_working(params.id ?? "") || blocked())
  createEffect(
    on(
      () => [sdk().directory, params.id, live()] as const,
      ([directory, id, working]) => {
        if (!id) return
        const cached = untrack(() => serverSync().session.data.todo[id] !== undefined)
        if (cached && !working) return
        // Completed lists are durable too: hydrate an idle session on its first open.
        let timer: ReturnType<typeof setTimeout> | undefined
        const frame = requestAnimationFrame(() => {
          timer = setTimeout(() => {
            if (sdk().directory !== directory || params.id !== id) return
            void serverSync().session.todo(id, cached ? { force: true } : undefined)
          }, 0)
        })
        onCleanup(() => {
          cancelAnimationFrame(frame)
          if (timer !== undefined) clearTimeout(timer)
        })
      },
    ),
  )
  const lastMessage = createMemo(() =>
    (sync().data.message[params.id ?? ""] ?? []).findLast((message) => message.role === "assistant"),
  )
  const lastUser = createMemo(() =>
    (sync().data.message[params.id ?? ""] ?? []).findLast((message) => message.role === "user"),
  )
  const delivered = createMemo(() =>
    todoDeliveryComplete({
      todos: todos(),
      working: live(),
      message: lastMessage(),
      userCreated: lastUser()?.time.created,
    }),
  )
  const [store, setStore] = createStore({ responding: undefined as string | undefined })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()
    if (!perm) return false
    return store.responding === perm.id
  })

  const decide = async (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()
    if (!perm || store.responding === perm.id) return false
    const sessionID = params.id

    setStore("responding", perm.id)
    return sdk()
      .client.v2.session.permission.reply(
        {
          sessionID: perm.sessionID,
          requestID: perm.id,
          reply: response,
        },
        { throwOnError: true },
      )
      .then(() => params.id === sessionID)
      .catch((err: unknown) => {
        const description = formatServerError(err, language.t)
        if (/Permission request not found/i.test(description)) {
          serverSync().session.set("permission", perm.sessionID, (items = []) =>
            items.filter((item) => item.id !== perm.id),
          )
          showToast({ title: language.t("session.permission.expired") })
          return false
        }
        showToast({ title: language.t("common.requestFailed"), description })
        return false
      })
      .finally(() => {
        setStore("responding", (id) => (id === perm.id ? undefined : id))
      })
  }

  return {
    blocked,
    questionRequest,
    permissionRequest,
    permissionResponding,
    decide,
    todos,
    // Keep incomplete and cancelled items available after a turn; these are presentation states.
    dock: () => todos().length > 0,
    delivered,
    deliveryKey: () => [params.id ?? "", lastMessage()?.id ?? ""].join(":"),
    closing: () => false,
    opening: () => false,
  }
}

export type SessionComposerController = ReturnType<typeof createSessionComposerController>
