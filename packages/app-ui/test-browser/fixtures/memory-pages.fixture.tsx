import { afterEach, expect, mock, test } from "bun:test"
import { createMemo, createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { MemoryRouter, Route, useLocation } from "@solidjs/router"
import { DialogProvider } from "@zaovra-ai/ui/context/dialog"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { createZaovraClient, type MemoryPage } from "@zaovra-ai/sdk/v2/client"
import { base64Encode } from "@zaovra-ai/core/util/encode"
import { dict } from "../../src/i18n/en"

const language = { locale: () => "en", t: (key: string) => dict[key as keyof typeof dict] ?? key }
let target: () => { scope: string; client: ReturnType<typeof createZaovraClient> }
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/server-sdk", () => ({ useServerSDK: () => target }))
const { MemoryPagesPanel } = await import("../../src/components/settings-v2/memory-pages")
const calls: { server: string; method: string; path: string; query: string; body: Record<string, unknown> }[] = []
let dispose: (() => void) | undefined
let changeProject: (directory: string) => void
let changeServer: (server: string) => void
let hold: Promise<void> | undefined
let conflict = false
let deleted = false
let currentPath = ""
let page: MemoryPage

function button(text: string) {
  const result = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (item) => item.textContent?.trim() === text,
  )
  if (!result) throw new Error(`Missing button ${text}`)
  return result
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("DOM condition did not settle")
}
async function mount(frozen = false) {
  page = {
    id: "mpg_fixture",
    scope: "project",
    title: "Build checks",
    summary: "Use the isolated harness",
    body: "Original page body",
    revision: "rev-original",
    origin: "consolidation",
    status: "current",
    time: { created: 1, updated: 2 },
    sources: [{ id: "mem_source", digest: "host-digest", sessionID: "ses_source", seq: 12 }],
  }
  const [directory, setDirectory] = createSignal("/project-a")
  const [server, setServer] = createSignal("server-a")
  changeProject = setDirectory
  changeServer = setServer
  const client = (server: string) =>
    createZaovraClient({
      baseUrl: `http://${server}`,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/api/session/ses_source") {
          calls.push({ server, method: request.method, path: url.pathname, query: url.search, body: {} })
          if (hold) await hold
          return Response.json({ data: { id: "ses_source", location: { directory: "/original-project" } } })
        }
        if (request.method === "GET")
          return Response.json({
            data: deleted || url.searchParams.get("location[directory]") === "/project-b" ? [] : [page],
          })
        const body = request.method === "PATCH" ? await request.json() : {}
        calls.push({ server, method: request.method, path: url.pathname, query: url.search, body })
        if (hold) await hold
        if (conflict) return Response.json({ reason: "conflict", message: "Stale revision" }, { status: 409 })
        if (request.method === "DELETE") {
          deleted = true
          return new Response(null, { status: 204 })
        }
        page = {
          ...page,
          summary: String(body.summary),
          body: String(body.body),
          revision: "rev-edited",
          origin: "user",
        }
        return Response.json({ data: page })
      },
    })
  const clients = { "server-a": client("server-a"), "server-b": client("server-b") }
  target = () => ({ scope: server(), client: clients[server() as keyof typeof clients] })
  const node = document.createElement("main")
  document.body.append(node)
  dispose = render(
    () => (
      <I18nProvider value={language}>
        <DialogProvider>
          <MemoryRouter>
            <Route
              path="*"
              component={() => {
                const route = useLocation()
                const keyed = createMemo(() => ({ directory: directory(), server: server() }))
                return (
                  <>
                    <span data-route>{(currentPath = route.pathname)}</span>
                    <Show when={keyed()} keyed>
                      {(where) => <MemoryPagesPanel directory={where.directory} projectFrozen={frozen} refresh={0} />}
                    </Show>
                  </>
                )
              }}
            />
          </MemoryRouter>
        </DialogProvider>
      </I18nProvider>
    ),
    node,
  )
  await until(() => !!document.querySelector('[data-slot="memory-page"]'))
}
afterEach(() => {
  dispose?.()
  dispose = undefined
  calls.length = 0
  hold = undefined
  conflict = false
  deleted = false
  document.body.replaceChildren()
})

test("page edits send the captured scope and revision and show protected content", async () => {
  await mount()
  button("Edit").click()
  const body = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Page content"]')!
  body.value = "My authoritative correction"
  body.dispatchEvent(new Event("input", { bubbles: true }))
  button("Save").click()
  await until(() => document.body.textContent?.includes("Edited by you") === true)
  expect(calls).toHaveLength(1)
  expect(calls[0].body).toEqual({
    summary: "Use the isolated harness",
    body: "My authoritative correction",
    expected: "rev-original",
  })
  expect(new URLSearchParams(calls[0].query).get("location[directory]")).toBe("/project-a")
  expect(new URLSearchParams(calls[0].query).get("layer")).toBe("project")
})

test("a concurrent edit fails visibly, retains the draft and does not force overwrite", async () => {
  await mount()
  button("Edit").click()
  conflict = true
  button("Save").click()
  await until(() => !!document.querySelector('[role="alert"]'))
  expect(document.querySelector("textarea") !== null).toBe(true)
  expect(calls).toHaveLength(1)
  expect(page.revision).toBe("rev-original")
})

test("delete needs confirmation; a frozen project leaves the user layer editable", async () => {
  await mount(true)
  expect(button("Edit").closest("fieldset")?.disabled).toBe(true)
  const select = document.querySelector<HTMLSelectElement>("select")!
  select.value = "user"
  select.dispatchEvent(new Event("change", { bubbles: true }))
  await until(() => !!document.querySelector('[data-slot="memory-page"]'))
  expect(button("Edit").closest("fieldset")?.disabled).toBe(false)
  button("Delete").click()
  expect(calls).toHaveLength(0)
  expect(document.body.textContent).toContain("Delete this page?")
  button("Delete").click()
  await until(() => calls.length === 1)
  expect(calls[0].method).toBe("DELETE")
  expect(new URLSearchParams(calls[0].query).get("layer")).toBe("user")
  await until(() => document.body.textContent?.includes("No knowledge pages") === true)
  expect(document.querySelector('[data-slot="memory-page"]') === null).toBe(true)
})

test("late edits remain on the original server and project after the panel is replaced", async () => {
  await mount()
  const gate = Promise.withResolvers<void>()
  hold = gate.promise
  button("Edit").click()
  button("Save").click()
  await until(() => calls.length === 1)
  changeProject("/project-b")
  changeServer("server-b")
  await until(() => document.body.textContent?.includes("No knowledge pages") === true)
  gate.resolve()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(calls).toHaveLength(1)
  expect(calls[0].server).toBe("server-a")
  expect(new URLSearchParams(calls[0].query).get("location[directory]")).toBe("/project-a")
  expect(document.querySelector('[data-slot="memory-page"]') === null).toBe(true)
})

test("source navigation uses the original session location, never the currently open project", async () => {
  await mount()
  button("Open source conversation #12").click()
  await until(() => currentPath.includes("ses_source"))
  expect(currentPath).toBe(`/${base64Encode("/original-project")}/session/ses_source`)
  expect(calls[0].path).toBe("/api/session/ses_source")
})

test("a late source lookup cannot navigate a replacement server", async () => {
  await mount()
  const gate = Promise.withResolvers<void>()
  hold = gate.promise
  button("Open source conversation #12").click()
  await until(() => calls.length === 1)
  changeServer("server-b")
  gate.resolve()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(currentPath).not.toContain("ses_source")
})
