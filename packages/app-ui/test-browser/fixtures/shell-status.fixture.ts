import { afterAll, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { ShellStatusItem } from "../../src/components/shell-status"

afterAll(() => GlobalRegistrator.unregister())
mock.module("../../src/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
mock.module("../../src/context/platform", () => ({ usePlatform: () => ({ openLink: () => {} }) }))

test("actual shell status clears stale effective details and renders failures", async () => {
  const { ShellStatus } = await import("../../src/components/shell-status")
  const [shells, setShells] = createSignal< ShellStatusItem[]>([
    { path: "/project/pwsh", effective: true, kind: "powershell", version: "7.4", source: "project" },
  ])
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(ShellStatus, { get shells() { return shells() } }), host)
  try {
    expect(host.textContent).toContain("/project/pwsh")
    expect(host.textContent).toContain("settings.shell.project")
    setShells([])
    expect(host.querySelector("[data-component=shell-status]")).toBeNull()
    setShells([{ path: "/other/sh", effective: true, error: "Shell unavailable" }])
    expect(host.textContent).toBe("Shell unavailable")
    expect(host.textContent).not.toContain("/project/pwsh")
  } finally {
    dispose()
    host.remove()
  }
})
