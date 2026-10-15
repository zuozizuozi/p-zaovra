import { mock } from "bun:test"
import assert from "node:assert/strict"
import { createRoot } from "solid-js"
import type { Event } from "@zaovra-ai/sdk/v2"

const locale = process.argv[2] === "zh" ? "zh" : "en"
mock.module("@zaovra-ai/ui/context", () => ({
  createSimpleContext: (options: { init: (props: { locale: string }) => unknown }) => ({
    use: () => options.init({ locale }),
  }),
}))
mock.module("../src/utils/persist", () => ({
  Persist: { global: () => ({}), serverGlobal: () => ({}) },
  persisted: (_key: unknown, store: unknown[]) => [...store, undefined, () => true],
}))
const { useLanguage, loadLocaleDict } = await import("../src/context/language")
await loadLocaleDict(locale)
let dispose = () => {}
try {
  const language = createRoot((cleanup) => {
    dispose = cleanup
    return useLanguage()
  })
  for (const key of ["missing.sample", "settings.permissions.tool.custom_xyz.description", "work.status.future"])
    assert.equal(language.t(key as Parameters<typeof language.t>[0]), key)
  assert.ok(language.t("session.permission.requestedAccess").length > 0)
  assert.notEqual(language.t("session.permission.requestedAccess"), "session.permission.requestedAccess")
  const notifications: string[][] = []
  let listener: (event: { name: string; details: Event }) => void = () => {
    throw new Error("listener missing")
  }
  mock.module("@solidjs/router", () => ({ useParams: () => ({}), useSearchParams: () => [{}] }))
  mock.module("../src/context/permission", () => ({
    usePermission: () => ({ ensureServerState: () => ({ autoResponds: () => false }) }),
  }))
  mock.module("../src/context/platform", () => ({
    usePlatform: () => ({
      notify: async (...args: string[]) => {
        notifications.push(args)
      },
    }),
  }))
  mock.module("../src/context/settings", () => ({
    useSettings: () => ({
      general: { newLayoutDesigns: () => true },
      sounds: { permissionsEnabled: () => false },
      notifications: { permissions: () => true },
    }),
  }))
  mock.module("../src/context/server", () => ({
    ServerConnection: { key: () => "http://localhost:9999" },
    useServer: () => ({ key: "http://localhost:9999", scope: () => "local" }),
  }))
  mock.module("../src/context/tabs", () => ({ useTabs: () => ({ store: [] }) }))
  mock.module("../src/context/global", () => ({
    useGlobal: () => ({
      servers: { list: () => [{}] },
      ensureServerCtx: () => ({
        sdk: {
          scope: "local",
          event: {
            listen: (fn: typeof listener) => {
              listener = fn
              return () => {}
            },
          },
        },
        sync: { ensureDirSyncContext: () => ({ session: { get: () => ({ title: "Task" }) } }) },
      }),
    }),
  }))
  const { useNotification } = await import("../src/context/notification")
  const cleanup = createRoot((cleanup) => {
    useNotification()
    return cleanup
  })
  try {
    const event = {
      name: "/repo",
      details: {
        type: "permission.asked" as const,
        properties: {
          id: "perm_unknown",
          sessionID: "ses_unknown",
          permission: "custom_xyz",
          patterns: ["*"],
          metadata: {},
          always: [],
        },
      },
    }
    listener(event)
    listener(event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]![1], language.t("session.permission.requestedAccess"))
    assert.ok(notifications[0]![2]!.endsWith("#permission=perm_unknown"))
  } finally {
    cleanup()
  }
  console.log("Language and notification passed")
} finally {
  dispose()
}
