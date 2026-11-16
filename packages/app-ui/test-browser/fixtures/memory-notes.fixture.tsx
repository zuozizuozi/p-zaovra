import { afterEach, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { dict } from "../../src/i18n/en"

const language = { locale: () => "en", t: (key: string) => dict[key as keyof typeof dict] ?? key }
let target: () => { scope: string; client: ReturnType<typeof createZaovraClient> }
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/server-sdk", () => ({ useServerSDK: () => target }))
mock.module("@/context/server-sync", () => ({
  useServerSync: () => () => ({ data: { config: {} }, session: { lineage: { peek: () => undefined } } }),
}))
// Keep this fixture on the ordinary-note controls; other panels have separate DOM suites.
mock.module("../../src/components/settings-v2/memory-tidy", () => ({ MemoryTidyPanel: () => null }))
mock.module("../../src/components/settings-v2/memory-pages", () => ({
  MemoryPagesPanel: () => null,
  MemorySourceLink: () => null,
}))
const { SettingsMemoryV2 } = await import("../../src/components/settings-v2/memory")
let dispose: (() => void) | undefined
let move: (value: { server?: string; directory?: string }) => void
let response: "ok" | "null" | "failure" = "ok"
let held: ReturnType<typeof Promise.withResolvers<void>> | undefined
const calls: {
  server: string
  directory: string | null
  layer: string | null
  method: string
  path: string
  body: Record<string, unknown>
}[] = []
const reads: string[] = []
const note = {
  id: "note",
  scope: "fixture",
  kind: "preference",
  text: "Original note",
  origin: "model",
  status: "unverified",
  hits: 1,
  time: { created: 1, updated: 1, observed: 1 },
}

async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error("Note DOM did not settle: " + document.body.textContent?.slice(-500))
}
function section(layer = "project") {
  return document.querySelector<HTMLElement>(`[data-slot="settings-memory-section"][data-layer="${layer}"]`)!
}
function button(key: keyof typeof dict, layer = "project") {
  return [...section(layer).querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === dict[key],
  )!
}
function input(edit = false, layer = "project") {
  return section(layer).querySelector<HTMLInputElement>(
    `input[aria-label="${language.t(edit ? "common.edit" : `settings.memory.${layer}.add`)}"]`,
  )!
}
function fill(value: string, edit = false, layer = "project") {
  input(edit, layer).value = value
  input(edit, layer).dispatchEvent(new Event("input", { bubbles: true }))
}
function busy() {
  return section().querySelector<HTMLFieldSetElement>("fieldset")?.disabled === true
}
async function mount() {
  const [state, setState] = createStore({ server: "a", directory: "/a" })
  move = (value) => setState(value)
  const endpoints = Object.fromEntries(
    ["a", "b"].map((server) => [
      server,
      createZaovraClient({
        baseUrl: `http://${server}.invalid`,
        throwOnError: true,
        fetch: async (request) => {
          const url = new URL(request.url)
          if (request.method === "GET") {
            reads.push(server + ":" + url.searchParams.get("location[directory]") + ":" + url.pathname)
            if (url.pathname === "/api/memory/recovery")
              return Response.json({
                data: {
                  scope: "fixture",
                  directory: state.directory,
                  frozen: false,
                  automaticFrozen: false,
                  state: "none",
                  deleted: 0,
                  notes: [],
                },
              })
            if (url.pathname === "/api/memory") return Response.json({ data: [note] })
            throw new Error("Unexpected read: " + url.pathname)
          }
          const body = request.method === "DELETE" ? {} : await request.json()
          calls.push({
            server,
            directory: url.searchParams.get("location[directory]"),
            layer: url.searchParams.get("layer"),
            method: request.method,
            path: url.pathname,
            body,
          })
          const result = response
          if (held) await held.promise
          if (result === "failure") return Response.json({ message: "Rejected" }, { status: 503 })
          if (request.method === "DELETE") return new Response(null, { status: 204 })
          return Response.json({ data: result === "null" ? null : { ...note, ...body } })
        },
      }),
    ]),
  )
  target = () => ({ scope: state.server, client: endpoints[state.server] })
  const node = document.createElement("main")
  document.body.append(node)
  dispose = render(
    () => (
      <I18nProvider value={language}>
        <SettingsMemoryV2 directory={state.directory} />
      </I18nProvider>
    ),
    node,
  )
  await until(
    () =>
      !!button("common.edit") &&
      document.querySelector<HTMLFieldSetElement>('[data-slot="memory-project"]')?.disabled === false,
  )
}
afterEach(() => {
  dispose?.()
  dispose = undefined
  held?.resolve()
  held = undefined
  document.body.replaceChildren()
  calls.length = 0
  reads.length = 0
  response = "ok"
})

for (const change of ["directory", "server"] as const) {
  test(`clear confirmation is revoked on ${change} change in the same mounted note panel`, async () => {
    await mount()
    button("settings.memory.clear").click()
    const stale = button("settings.memory.clear")
    expect(section().textContent).toContain(dict["settings.memory.clear.confirm"])
    move(change === "directory" ? { directory: "/b" } : { server: "b" })
    await until(() => document.querySelector<HTMLFieldSetElement>('[data-slot="memory-project"]')?.disabled === false)
    expect(section().textContent).not.toContain(dict["settings.memory.clear.confirm"])
    stale.click()
    expect(calls).toHaveLength(0)
    button("settings.memory.clear").click()
    button("settings.memory.clear").click()
    await until(() => calls.length === 1 && !busy())
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      path: "/api/memory",
      server: change === "server" ? "b" : "a",
      directory: change === "directory" ? "/b" : "/a",
      layer: "project",
    })
  })
}
for (const action of ["add", "save"] as const) {
  for (const failure of ["null", "failure"] as const) {
    test(`${action} ${failure} keeps input and permits a successful retry`, async () => {
      await mount()
      if (action === "save") button("common.edit").click()
      fill("Keep this draft", action === "save")
      response = failure
      button(action === "save" ? "common.save" : "settings.memory.add").click()
      await until(() => !!section().querySelector('[role="alert"]') && !busy())
      expect(input(action === "save").value).toBe("Keep this draft")
      expect(calls).toHaveLength(1)
      response = "ok"
      button(action === "save" ? "common.save" : "settings.memory.add").click()
      await until(() => calls.length === 2 && !busy())
      expect(section().querySelector('[role="alert"]')).toBeNull()
      if (action === "save") expect(input(true)).toBeNull()
      if (action === "add") expect(input().value).toBe("")
    })
  }
}
for (const result of ["ok", "failure"] as const) {
  test(`late ${result} cannot clear a newer draft or error state after switching away and back`, async () => {
    await mount()
    response = result
    held = Promise.withResolvers<void>()
    fill("Old draft")
    button("settings.memory.add").click()
    button("settings.memory.add").click()
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await until(() => calls.length === 1)
    expect(busy()).toBe(true)
    move({ directory: "/b", server: "b" })
    await until(() => document.querySelector<HTMLFieldSetElement>('[data-slot="memory-project"]')?.disabled === false)
    move({ directory: "/a", server: "a" })
    await until(() => document.querySelector<HTMLFieldSetElement>('[data-slot="memory-project"]')?.disabled === false)
    fill("New target draft")
    const before = reads.length
    held.resolve()
    await Bun.sleep(30)
    expect(input().value).toBe("New target draft")
    expect(section().querySelector('[role="alert"]')).toBeNull()
    expect(reads).toHaveLength(before)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ server: "a", directory: "/a", body: { text: "Old draft", layer: "project" } })
  })
}
test("user clear remains user scoped and rejects duplicate pending confirmation", async () => {
  await mount()
  held = Promise.withResolvers<void>()
  button("settings.memory.clear", "user").click()
  button("settings.memory.clear", "user").click()
  button("settings.memory.clear", "user").click()
  await until(() => calls.length === 1)
  expect(calls[0]).toMatchObject({ method: "DELETE", server: "a", directory: "/a", layer: "user" })
  held.resolve()
  await until(() => !busy())
  expect(section("user").textContent).not.toContain(dict["settings.memory.clear.confirm"])
})
