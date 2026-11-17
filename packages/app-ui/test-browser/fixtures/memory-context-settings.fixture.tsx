import { afterEach, expect, mock, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter, Route } from "@solidjs/router"
import { DialogProvider } from "@zaovra-ai/ui/context/dialog"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { dict } from "../../src/i18n/en"

const language = { locale: () => "en", t: (key: string) => dict[key as keyof typeof dict] ?? key }
let target: () => { scope: string; client: ReturnType<typeof createZaovraClient> }
let sync: () => unknown
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/server-sdk", () => ({ useServerSDK: () => target }))
mock.module("@/context/server-sync", () => ({ useServerSync: () => sync }))
const { SettingsMemoryV2 } = await import("../../src/components/settings-v2/memory")
let dispose: (() => void) | undefined
let changeServer: (server: string) => void
let hold: Promise<void> | undefined
let fail = false
const calls: { server: string; body: Record<string, unknown> }[] = []

async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error("DOM did not settle")
}
function toggle(action: string) {
  const control = document.querySelector<HTMLElement>(`[data-action="settings-memory-${action}"] [role="switch"]`)
  if (!control) throw new Error("Missing switch " + action)
  return control
}
async function mount(
  initial: {
    memory?: {
      enabled?: boolean
      taskSearch?: boolean
      index?: { enabled?: boolean; maxLines?: number; maxBytes?: number }
    }
  } = {
    memory: { enabled: true, taskSearch: true, index: { enabled: true, maxLines: 100, maxBytes: 8192 } },
  },
) {
  const [server, setServer] = createSignal("a")
  changeServer = setServer
  const endpoints = Object.fromEntries(
    ["a", "b"].map((name) => {
      const [config, setConfig] = createSignal(initial)
      const client = createZaovraClient({
        baseUrl: `http://${name}.invalid`,
        throwOnError: true,
        fetch: async (request) => {
          const path = new URL(request.url).pathname
          if (request.method === "GET" && (path === "/api/memory" || path === "/api/memory/pages"))
            return Response.json({ data: [] })
          if (request.method === "PATCH" && path === "/global/config") {
            const body = await request.json()
            calls.push({ server: name, body })
            if (hold) await hold
            if (fail) return Response.json({ message: "save failed" }, { status: 503 })
            return Response.json(body)
          }
          throw new Error("Unexpected fixture request: " + request.method + " " + path)
        },
      })
      return [
        name,
        {
          scope: name,
          client,
          state: {
            data: {
              get config() {
                return config()
              },
            },
            session: { lineage: { peek: () => undefined } },
            updateConfig: async (value: ReturnType<typeof config>) => {
              const result = await client.global.config.update({ config: value }, { throwOnError: true })
              setConfig(result.data as ReturnType<typeof config>)
            },
          },
        },
      ]
    }),
  )
  target = () => endpoints[server()]
  sync = () => endpoints[server()].state
  const container = document.createElement("main")
  document.body.append(container)
  dispose = render(
    () => (
      <I18nProvider value={language}>
        <DialogProvider>
          <MemoryRouter>
            <Route path="*" component={() => <SettingsMemoryV2 />} />
          </MemoryRouter>
        </DialogProvider>
      </I18nProvider>
    ),
    container,
  )
  await until(() => !!document.querySelector('[data-action="settings-memory-search"]'))
}

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  hold = undefined
  fail = false
  calls.length = 0
})

test("memory switches preserve independent settings and save through the real SDK", async () => {
  await mount()
  toggle("search").click()
  await until(() => calls.length === 1 && toggle("search").getAttribute("aria-checked") === "false")
  expect(calls[0].body).toEqual({
    memory: { enabled: true, taskSearch: false, index: { enabled: true, maxLines: 100, maxBytes: 8192 } },
  })
  toggle("index").click()
  await until(() => calls.length === 2 && toggle("index").getAttribute("aria-checked") === "false")
  expect(calls[1].body).toEqual({
    memory: { enabled: true, taskSearch: false, index: { enabled: false, maxLines: 100, maxBytes: 8192 } },
  })
  toggle("enabled").click()
  await until(() => calls.length === 3 && toggle("enabled").getAttribute("aria-checked") === "false")
  expect(calls[2].body).toEqual({
    memory: { enabled: false, taskSearch: false, index: { enabled: false, maxLines: 100, maxBytes: 8192 } },
  })
})

test("invalid index limits are not saved and valid changes preserve other values", async () => {
  await mount()
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Lines"]')!
  input.value = "201"
  input.dispatchEvent(new Event("change", { bubbles: true }))
  await Bun.sleep(10)
  expect(calls).toHaveLength(0)
  input.value = "120"
  input.dispatchEvent(new Event("change", { bubbles: true }))
  await until(() => calls.length === 1)
  expect(calls[0].body).toEqual({
    memory: { enabled: true, taskSearch: true, index: { enabled: true, maxLines: 120, maxBytes: 8192 } },
  })
})

test("a late save failure from another server does not disable or alert the new panel", async () => {
  await mount()
  let release = () => {}
  hold = new Promise<void>((resolve) => {
    release = resolve
  })
  fail = true
  toggle("search").click()
  await until(() => calls.length === 1)
  changeServer("b")
  await until(() => toggle("search").getAttribute("aria-disabled") !== "true")
  release()
  await Bun.sleep(25)
  expect(document.body.textContent).not.toContain(dict["settings.memory.config.failed"])
  expect(calls[0].server).toBe("a")
  hold = undefined
  fail = false
  toggle("index").click()
  await until(() => calls.length === 2)
  expect(calls[1].server).toBe("b")
})

for (const initial of [{}, { memory: {} }, { memory: { enabled: false } }]) {
  test(`memory defaults off without writing config: ${JSON.stringify(initial)}`, async () => {
    await mount(initial)
    expect(toggle("enabled").getAttribute("aria-checked")).toBe("false")
    expect(toggle("search").hasAttribute("disabled") || toggle("search").getAttribute("aria-disabled") === "true").toBe(
      true,
    )
    expect(calls).toHaveLength(0)
    toggle("enabled").click()
    await until(() => calls.length === 1 && toggle("enabled").getAttribute("aria-checked") === "true")
    expect(calls[0].body).toEqual({ memory: { enabled: true } })
  })
}
