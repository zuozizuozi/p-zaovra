import { expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { Show } from "solid-js"
import type { PermissionView } from "@zaovra-ai/sdk/v2/client"
import { ServerScope } from "../../src/utils/server-scope"

const [params, setParams] = createStore({ id: "ses_a" })
const sessions = { ses_a: { id: "ses_a", directory: "/fixture" }, ses_b: { id: "ses_b", directory: "/fixture" } }
const [data, setData] = createStore({ info: sessions, permission: {} as Record<string, PermissionView[]> })
const listeners = new Set<(event: { name: string; details: { type: string; properties: PermissionView } }) => void>()
let reply = async (_request: { requestID: string; reply: string }) => {}
const sync = {
  child: () => [{ config: {}, session: Object.values(sessions) }],
  session: {
    data,
    lineage: {
      peek: (id: keyof typeof sessions) => ({ session: sessions[id] }),
      resolve: async (id: keyof typeof sessions) => ({ session: sessions[id] }),
    },
  },
}
const sdk = {
  scope: ServerScope.local,
  event: {
    listen: (callback: Parameters<typeof listeners.add>[0]) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  },
  client: {
    v2: {
      permission: { request: { list: async () => ({ data: { data: [] } }) } },
      session: {
        permission: {
          reply: async (request: { requestID: string; reply: string }, options: { throwOnError: boolean }) => {
            expect(options.throwOnError).toBe(true)
            return reply(request)
          },
        },
      },
    },
  },
}
mock.module("@solidjs/router", () => ({ useParams: () => params, useSearchParams: () => [{}] }))
mock.module("@/context/global", () => ({
  useGlobal: () => ({ servers: { list: () => [{ id: "fixture" }] }, ensureServerCtx: () => ({ sdk, sync }) }),
}))
mock.module("@/context/tabs", () => ({ useTabs: () => ({ store: [] }) }))
mock.module("@/context/server", () => ({
  useServer: () => ({ key: "fixture", scope: () => ServerScope.local }),
  ServerConnection: { key: () => "fixture" },
}))
mock.module("@/context/settings", () => ({ useSettings: () => ({ general: { newLayoutDesigns: () => true } }) }))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web", openLink: () => {} }) }))
const { PermissionProvider, usePermission } = await import("../../src/context/permission")
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

for (const mode of ["automatic", "full"] as const) {
  for (const scenario of ["before-send", "lost-ack", "other-window", "session-switch", "mode-revoked"] as const) {
    test(`707 real permission state ${mode} ${scenario} exposes a manual card and never reapproves on resync`, async () => {
      const request: PermissionView = {
        id: `per_${mode}_${scenario}`,
        sessionID: "ses_a",
        permission: "write",
        patterns: [],
        always: [],
        metadata: {},
      }
      const gate = Promise.withResolvers<void>()
      let calls = 0
      let effects = 0
      reply = async () => {
        calls++
        if (scenario !== "before-send") effects++
        await gate.promise
      }
      setParams("id", "ses_a")
      setData("permission", "ses_a", [request])
      let api: ReturnType<typeof usePermission>
      const Probe = () => {
        api = usePermission()
        return (
          <Show
            when={
              data.permission.ses_a?.some((item) => item.id === request.id) && !api.autoResponds(request, "/fixture")
            }
          >
            <button
              data-slot="manual-permission"
              onClick={() => api.respond({ sessionID: request.sessionID, permissionID: request.id, response: "once" })}
            >
              Approve
            </button>
          </Show>
        )
      }
      const host = document.createElement("main")
      document.body.append(host)
      const dispose = render(
        () => (
          <PermissionProvider>
            <Probe />
          </PermissionProvider>
        ),
        host,
      )
      try {
        await settle()
        api!.setMode("/fixture", mode)
        listeners.forEach((listener) =>
          listener({ name: "/fixture", details: { type: "permission.asked", properties: request } }),
        )
        await settle()
        expect(calls).toBe(1)
        expect(host.querySelector("[data-slot=manual-permission]")).toBeNull()
        if (scenario === "other-window") setData("permission", "ses_a", [])
        if (scenario === "session-switch") setParams("id", "ses_b")
        if (scenario === "mode-revoked") api!.setMode("/fixture", "ask")
        gate.reject(new Error("acknowledgement unavailable"))
        await settle()
        setParams("id", "ses_a")
        expect(effects).toBe(scenario === "before-send" ? 0 : 1)
        expect(!!host.querySelector("[data-slot=manual-permission]")).toBe(scenario !== "other-window")
        if (scenario !== "other-window") expect(api!.autoReplyError(request)).toBeInstanceOf(Error)
        setData("permission", "ses_a", (items) => items.map((item) => ({ ...item })))
        if (scenario === "mode-revoked") api!.setMode("/fixture", mode)
        listeners.forEach((listener) =>
          listener({ name: "/fixture", details: { type: "permission.asked", properties: { ...request } } }),
        )
        await settle()
        expect(calls).toBe(1)
        if (scenario !== "other-window") {
          reply = async () => {
            calls++
            setData("permission", "ses_a", [])
          }
          host.querySelector<HTMLButtonElement>("[data-slot=manual-permission]")!.click()
          await settle()
          expect(calls).toBe(2)
          expect(host.querySelector("[data-slot=manual-permission]")).toBeNull()
        }
      } finally {
        dispose()
        host.remove()
      }
      expect(listeners.size).toBe(0)
    })
  }
}
