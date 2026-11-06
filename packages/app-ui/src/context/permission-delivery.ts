import { createStore } from "solid-js/store"
import type { PermissionView } from "@zaovra-ai/sdk/v2/client"

/** A failed acknowledgement is ambiguous: expose the card, never approve it again automatically. */
export function createPermissionDelivery(input: {
  reply: (permission: PermissionView) => Promise<unknown>
  pending: (permission: PermissionView) => boolean
  disposed: () => boolean
}) {
  const [failed, setFailed] = createStore<Record<string, unknown>>({})
  const attempts = new Map<string, { at: number; permission: PermissionView }>()
  const key = (permission: PermissionView) => JSON.stringify([permission.sessionID, permission.id])
  return {
    error: (permission: PermissionView) => failed[key(permission)],
    async once(permission: PermissionView) {
      if (input.disposed() || !input.pending(permission) || attempts.has(key(permission))) return
      const now = Date.now()
      // Keep uncertain approvals until their request leaves the pending set.
      for (const [id, item] of attempts) {
        if ((now - item.at < 60 * 60 * 1000 && attempts.size < 1000) || input.pending(item.permission)) continue
        attempts.delete(id)
        setFailed(id, undefined)
      }
      attempts.set(key(permission), { at: now, permission })
      await input.reply(permission).catch((error: unknown) => {
        if (!input.disposed() && input.pending(permission))
          setFailed(key(permission), () => error || new Error("Permission reply failed"))
      })
    },
  }
}
