import { expect, test } from "bun:test"
import { createRoot, createEffect } from "solid-js"
import type { PermissionView } from "@zaovra-ai/sdk/v2/client"
import { createPermissionDelivery } from "@/context/permission-delivery"

for (const outcome of ["before-send", "lost-ack", "other-window"] as const) {
  test(`707 automatic permission ${outcome} restores failure visibility without a second approval`, async () => {
    await createRoot(async (dispose) => {
      const gate = Promise.withResolvers<void>()
      const permission = {
        id: "per_1",
        sessionID: "ses_1",
        permission: "write",
        patterns: [],
        always: [],
        metadata: {},
      } satisfies PermissionView
      let pending = [permission]
      let calls = 0
      let effects = 0
      let disposed = false
      const delivery = createPermissionDelivery({
        reply: async () => {
          calls++
          if (outcome !== "before-send") effects++
          await gate.promise
        },
        pending: (request) => pending.some((item) => item.sessionID === request.sessionID && item.id === request.id),
        disposed: () => disposed,
      })
      const visible: boolean[] = []
      createEffect(() => {
        visible.push(!!delivery.error(permission))
      })
      const first = delivery.once(permission)
      await delivery.once({ ...permission })
      if (outcome === "other-window") pending = []
      gate.reject(new Error("network acknowledgement lost"))
      await first
      expect(calls).toBe(1)
      expect(effects).toBe(outcome === "before-send" ? 0 : 1)
      expect(!!delivery.error(permission)).toBe(outcome !== "other-window")
      pending = pending.map((item) => ({ ...item }))
      await delivery.once({ ...permission })
      expect(calls).toBe(1)
      if (outcome !== "other-window") expect(visible.at(-1)).toBe(true)
      disposed = true
      dispose()
    })
  })
}

test("707 delivery deduplicates server/session/request and releases a successful card through server state", async () => {
  let calls = 0
  const delivery = createPermissionDelivery({
    reply: async () => {
      calls++
    },
    pending: () => true,
    disposed: () => false,
  })
  const p = { id: "same", sessionID: "s1" } as PermissionView
  await delivery.once(p)
  await delivery.once({ ...p })
  await delivery.once({ ...p, sessionID: "s2" })
  expect(calls).toBe(2)
  expect(delivery.error(p)).toBeUndefined()
})

test("707 a rejected false acknowledgement is still a visible failure", async () => {
  const delivery = createPermissionDelivery({
    reply: async () => {
      throw false
    },
    pending: () => true,
    disposed: () => false,
  })
  const permission = { id: "p", sessionID: "s" } as PermissionView
  await delivery.once(permission)
  expect(delivery.error(permission)).toBeInstanceOf(Error)
})
