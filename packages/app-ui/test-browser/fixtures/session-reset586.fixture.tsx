import { expect, mock, test } from "bun:test"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { render } from "solid-js/web"
import { I18nProvider } from "@zaovra-ai/ui/context/i18n"
import { dict } from "../../src/i18n/zh"
import { sessionNotFoundError } from "../../src/utils/server-errors"
const router = await import("@solidjs/router")
const language = { locale: () => "zh", t: (key: string) => dict[key as keyof typeof dict] ?? key }
const navigations: string[] = []
const removed: unknown[] = []
const tabs = {
  store: [] as { type: string; server: string; sessionId: string }[],
  removeSessionTab: (input: unknown) => removed.push(input),
}
mock.module("@solidjs/router", () => ({ ...router, useNavigate: () => (url: string) => navigations.push(url) }))
const settings = await import("../../src/context/settings")
mock.module("@/context/settings", () => ({
  ...settings,
  useSettings: () => ({ general: { newLayoutDesigns: () => true } }),
}))
const actualLanguage = await import("../../src/context/language")
mock.module("@/context/language", () => ({ ...actualLanguage, useLanguage: () => language }))
const server = await import("../../src/context/server")
mock.module("@/context/server", () => ({ ...server, useServer: () => ({ key: "fixture", list: [] }) }))
const actualTabs = await import("../../src/context/tabs")
mock.module("@/context/tabs", () => ({ ...actualTabs, useTabs: () => tabs }))
mock.module("@/pages/error", () => ({ ErrorPage: () => <span data-error="network">Network error</span> }))
const { SessionRouteErrorBoundary } = await import("../../src/pages/session")
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test("actual boundary recovers on identity change, healthy session switches retain their workspace, missing untabbed session closes home", async () => {
  const [id, setID] = createSignal("missing")
  const host = document.createElement("main")
  document.body.append(host)
  let mounts = 0
  let cleanups = 0
  const Workspace = () => {
    mounts++
    onCleanup(() => cleanups++)
    createEffect(() => {
      if (id() === "missing") throw sessionNotFoundError("missing")
      if (id() === "network") throw new Error("fixture network failure")
    })
    return <span data-workspace>{id()}</span>
  }
  const dispose = render(
    () => (
      <I18nProvider value={language}>
        <SessionRouteErrorBoundary sessionID={id()} serverKey={"fixture" as never}>
          <Workspace />
        </SessionRouteErrorBoundary>
      </I18nProvider>
    ),
    host,
  )
  try {
    await settle()
    expect(host.textContent).toContain(language.t("session.error.notFound"))
    host.querySelector<HTMLButtonElement>("button")!.click()
    expect(navigations).toEqual(["/"])
    expect(removed).toHaveLength(0)
    setID("healthy-a")
    await settle()
    expect(host.querySelector("[data-workspace]")?.textContent).toBe("healthy-a")
    const before = { mounts, cleanups }
    setID("healthy-b")
    await settle()
    expect(host.querySelector("[data-workspace]")?.textContent).toBe("healthy-b")
    expect({ mounts, cleanups }).toEqual(before)
    setID("network")
    await settle()
    expect(host.querySelector("[data-error=network]")).not.toBeNull()
    setID("healthy-c")
    await settle()
    expect(host.querySelector("[data-workspace]")?.textContent).toBe("healthy-c")
    tabs.store.push({ type: "session", server: "fixture", sessionId: "missing" })
    setID("missing")
    await settle()
    host.querySelector<HTMLButtonElement>("button")!.click()
    expect(removed).toEqual([{ server: "fixture", sessionId: "missing" }])
    expect(navigations).toHaveLength(1)
  } finally {
    dispose()
    host.remove()
  }
})
