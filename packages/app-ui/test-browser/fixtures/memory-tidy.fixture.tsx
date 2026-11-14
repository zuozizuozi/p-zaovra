import { afterEach, expect, mock, test } from "bun:test"
import { render } from "solid-js/web"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { DialogProvider } from "@zaovra-ai/ui/context/dialog"
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

async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error("DOM condition timed out: " + document.body.textContent?.slice(-700))
}
function action() {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-action="settings-memory-tidy"] button')].find(
    (x) => x.textContent?.trim() === "Tidy now",
  )!
}
function picker() {
  return document.querySelector<HTMLButtonElement>('[aria-label="Model for this tidy"]')!
}
async function mount() {
  calls.length = 0
  localWrites = 0
  client = createZaovraClient({
    baseUrl: "http://tidy.invalid",
    throwOnError: true,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
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
          <SettingsMemoryV2 directory="/tidy-project" />
        </DialogProvider>
      </I18nProvider>
    ),
    node,
  )
  await until(() => !!action())
}
async function choose() {
  picker().click()
  await until(() => !!document.querySelector('[data-option-key="configured:chat-b"]'))
  expect(document.querySelector('[data-option-key="configured:embedding"]')).toBeNull()
  expect(document.querySelector('[data-option-key="action:manage"]')).toBeNull()
  document.querySelector<HTMLButtonElement>('[data-option-key="configured:chat-b"]')!.click()
  await until(() => picker().textContent?.includes("Configured chat") === true)
}
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  failure = undefined
  hold = undefined
})

test("tidy selected configured model reaches real SDK create body without changing daily model", async () => {
  await mount()
  await choose()
  action().click()
  await until(() => calls.some((x) => x.path.endsWith("/prompt")))
  expect(calls[0].body).toMatchObject({
    location: { directory: "/tidy-project" },
    budget: { tokens: 300000 },
    model: { id: "chat-b", providerID: "configured" },
  })
  expect(localWrites).toBe(0)
  await until(() => document.body.textContent?.includes("Started.") === true)
  action().click()
  expect(calls).toHaveLength(2)
})
for (const reset of [false, true])
  test(`tidy default omits model after selection reset=${reset}`, async () => {
    await mount()
    if (reset) {
      await choose()
      ;[...document.querySelectorAll<HTMLButtonElement>('[data-action="settings-memory-tidy"] button')]
        .find((x) => x.textContent?.trim() === "Use default")!
        .click()
    }
    action().click()
    await until(() => calls.length === 2)
    expect(Object.hasOwn(calls[0].body, "model")).toBe(false)
    expect(localWrites).toBe(0)
  })
for (const stage of ["create", "prompt"] as const)
  test(`tidy ${stage} failure retries same identities and prevents duplicate starts`, async () => {
    await mount()
    await choose()
    failure = stage
    const gate = Promise.withResolvers<void>()
    hold = gate.promise
    action().click()
    action().click()
    await until(() => calls.length === 1)
    expect(action().disabled).toBe(true)
    expect(calls).toHaveLength(1)
    hold = undefined
    gate.resolve()
    await until(() => document.body.textContent?.includes("Could not start.") === true)
    expect(action().disabled).toBe(false)
    expect(picker().disabled).toBe(true)
    action().click()
    await until(() => document.body.textContent?.includes("Started.") === true)
    const creates = calls.filter((x) => x.path === "/api/session")
    const prompts = calls.filter((x) => x.path.endsWith("/prompt"))
    expect(creates).toHaveLength(stage === "create" ? 2 : 1)
    expect(prompts).toHaveLength(stage === "prompt" ? 2 : 1)
    expect(new Set(creates.map((x) => JSON.stringify(x.body))).size).toBe(1)
    expect(new Set(prompts.map((x) => JSON.stringify(x))).size).toBe(1)
    expect(creates[0].body.model).toEqual({ id: "chat-b", providerID: "configured" })
    expect(localWrites).toBe(0)
  })
