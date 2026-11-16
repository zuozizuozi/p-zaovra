import { afterEach, expect, mock, test, spyOn } from "bun:test"
import { render } from "solid-js/web"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { DialogProvider } from "@zaovra-ai/ui/context/dialog"
import { MemoryRouter, Route } from "@solidjs/router"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { dict } from "../../src/i18n/en"

const language = { locale: () => "en", t: (key: string) => dict[key as keyof typeof dict] ?? key }
const items = [
  {
    id: "chat-b",
    baseModelID: "chat-b",
    name: "Configured chat",
    provider: { id: "configured", name: "Configured" },
    limit: { context: 10000 },
    variants: {},
  },
  {
    id: "embedding",
    baseModelID: "embedding",
    name: "Embedding only",
    provider: { id: "configured", name: "Configured" },
    limit: { context: 10000 },
    variants: {},
  },
]
let client: ReturnType<typeof createZaovraClient>
let localWrites = 0
mock.module("@/context/language", () => ({ useLanguage: () => language }))
mock.module("@/context/local", () => ({
  useLocal: () => {
    localWrites++
    throw new Error("Tidy must not touch conversation selection")
  },
}))
mock.module("@/context/models", () => ({
  useModels: () => ({
    list: () => items,
    visible: () => true,
    type: (key: { modelID: string }) => (key.modelID === "embedding" ? "embedding" : "chat"),
    catalog: { refresh: async () => {}, loading: () => false, error: () => undefined },
  }),
}))
mock.module("@/context/server-sdk", () => ({ useServerSDK: () => () => ({ scope: "tidy-test", client }) }))
mock.module("@/context/server-sync", () => ({
  useServerSync: () => () => ({ data: { config: {} }, session: { lineage: { peek: () => undefined } } }),
}))
const { SettingsMemoryV2 } = await import("../../src/components/settings-v2/memory")
let dispose: (() => void) | undefined
const calls: { path: string; body: Record<string, unknown> }[] = []
let failure: "create" | "prompt" | undefined
let hold: Promise<void> | undefined
let recoveryFailure = false
const legacy = () => ({
  scope: "dir_posix_v2_fixture",
  legacyScope: "dir_old",
  directory: "/tidy-project",
  frozen: true,
  automaticFrozen: true,
  state: "pending",
  deleted: 2,
  notes: [
    {
      note: {
        id: "old-a",
        text: "Choose this legacy note",
        kind: "practice",
        origin: "model",
        status: "unverified",
        scope: "dir_old",
        hits: 1,
        time: { created: 1, updated: 1, observed: 1 },
      },
      restorable: true,
      restored: false,
      reason: "uncertain",
    },
    {
      note: {
        id: "old-b",
        text: "Read only legacy note",
        kind: "practice",
        origin: "model",
        status: "unverified",
        scope: "dir_old",
        hits: 1,
        time: { created: 1, updated: 1, observed: 1 },
      },
      restorable: false,
      restored: false,
      reason: "deleted conflict",
    },
  ],
})
let recovery = legacy()

async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error("DOM condition timed out: " + document.body.textContent?.slice(-700))
}
function action() {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-slot="memory-tidy"] button')].find(
    (x) => x.textContent?.trim() === "Review and confirm",
  )!
}
function picker() {
  return document.querySelector<HTMLButtonElement>('[aria-label="Model for this tidy"]')!
}
async function mount() {
  calls.length = 0
  localWrites = 0
  recovery = legacy()
  client = createZaovraClient({
    baseUrl: "http://tidy.invalid",
    throwOnError: true,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === "GET" && path === "/api/memory/automatic") return Response.json({ data: null })
      if (request.method === "GET" && path === "/api/memory/pages") return Response.json({ data: [] })
      if (request.method === "GET" && path === "/api/memory/tidy") return Response.json({ data: [] })
      if (request.method === "GET" && path === "/api/memory/recovery") return Response.json({ data: recovery })
      if (request.method === "GET" && path === "/api/memory")
        return Response.json({
          data: [
            {
              id: "note1",
              text: "Preference",
              status: "verified",
              kind: "preference",
              time: { observed: 1, created: 1, updated: 1 },
            },
          ],
        })
      const body = (await request.json()) as Record<string, unknown>
      calls.push({ path, body })
      if (path === "/api/memory/recovery") {
        if (recoveryFailure) return Response.json({ message: "offline" }, { status: 503 })
        recovery = {
          ...recovery,
          frozen: false,
          state: body.decision === "blank" ? "blank" : "restored",
          notes: recovery.notes.map((item) => ({
            ...item,
            restored: body.decision === "restore" && item.note.id === "old-a",
            restorable: false,
          })),
        }
        return Response.json({ accepted: true, data: recovery })
      }
      if (path === "/api/session" || path.endsWith("/prompt")) {
        if (hold) await hold
        if ((failure === "create" && path === "/api/session") || (failure === "prompt" && path.endsWith("/prompt"))) {
          failure = undefined
          return Response.json({ message: "Simulated lost response" }, { status: 503 })
        }
        return Response.json({ data: path === "/api/session" ? { id: body.id } : {} })
      }
      throw new Error("Unexpected request " + path)
    },
  })
  // HappyDOM has no CSS animations; make the computed no-animation state explicit for Kobalte presence.
  const css = document.createElement("style")
  css.textContent = "* { animation-name: none !important; }"
  document.body.append(css)
  const node = document.createElement("main")
  document.body.append(node)
  dispose = render(
    () => (
      <I18nProvider value={language}>
        <DialogProvider>
          <MemoryRouter>
            <Route path="*" component={() => <SettingsMemoryV2 directory="/tidy-project" />} />
          </MemoryRouter>
        </DialogProvider>
      </I18nProvider>
    ),
    node,
  )
  await until(() => !!document.querySelector('[data-slot="memory-recovery"]'))
}

function recoveryButton(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-slot="memory-recovery"] button')].find(
    (button) => button.textContent?.trim() === text,
  )!
}
function selectNote() {
  document.querySelector<HTMLInputElement>('[data-slot="memory-recovery-note"] input')!.click()
}
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  recoveryFailure = false
  mock.restore()
})

test("settings show uncertain legacy notes and freeze controls until explicit per-note confirmation", async () => {
  await mount()
  expect(document.body.textContent).toContain("may mix several directories")
  expect(document.querySelector<HTMLFieldSetElement>('[data-slot="memory-project"]')!.disabled).toBe(true)
  expect(action().disabled).toBe(true)
  const boxes = document.querySelectorAll<HTMLInputElement>('[data-slot="memory-recovery-note"] input')
  expect(boxes[0].checked).toBe(false)
  expect(boxes[1].disabled).toBe(true)
  expect(calls).toHaveLength(0)
  selectNote()
  recoveryButton("Confirm selected notes belong here and restore").click()
  await until(() => !document.querySelector<HTMLFieldSetElement>('[data-slot="memory-project"]')!.disabled)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toEqual({ path: "/api/memory/recovery", body: { decision: "restore", ids: ["old-a"] } })
  expect(document.body.textContent).toContain("Your choice is saved")
  expect(document.body.textContent).toContain("Automatic recording and model reviews remain paused")
  expect(action().disabled).toBe(true)
})

test("blank choice requires an explicit second click and never selects old notes", async () => {
  await mount()
  recoveryButton("Start this directory blank").click()
  expect(calls).toHaveLength(0)
  recoveryButton("Confirm: do not copy old notes; keep deletion protection").click()
  await until(() => !document.querySelector<HTMLFieldSetElement>('[data-slot="memory-project"]')!.disabled)
  expect(calls[0].body).toEqual({ decision: "blank", ids: [] })
  expect(document.body.textContent).toContain("Legacy deletion records")
})

test("failed confirmation remains frozen and retries the same explicit selection", async () => {
  await mount()
  recoveryFailure = true
  selectNote()
  recoveryButton("Confirm selected notes belong here and restore").click()
  await until(() => !!document.querySelector('[role="alert"]'))
  expect(document.querySelector<HTMLFieldSetElement>('[data-slot="memory-project"]')!.disabled).toBe(true)
  recoveryFailure = false
  recoveryButton("Confirm selected notes belong here and restore").click()
  await until(() => !document.querySelector<HTMLFieldSetElement>('[data-slot="memory-project"]')!.disabled)
  expect(calls).toHaveLength(2)
  expect(calls[1].body).toEqual(calls[0].body)
})

test("export uses visible legacy JSON without confirming or changing old notes", async () => {
  await mount()
  const downloads: Blob[] = []
  const urls = spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    downloads.push(blob as Blob)
    return "blob:fixture"
  })
  const clicks = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
  recoveryButton("Export legacy notes (JSON)").click()
  expect(clicks).toHaveBeenCalledTimes(1)
  expect(JSON.parse(await downloads[0].text())).toMatchObject({
    frozen: true,
    deleted: 2,
    notes: [{ note: { id: "old-a" } }, { note: { id: "old-b" } }],
  })
  expect(calls).toHaveLength(0)
  urls.mockRestore()
  clicks.mockRestore()
})
