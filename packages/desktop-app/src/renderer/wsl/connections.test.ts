import { describe, expect, test } from "bun:test"
import type { WslServersState } from "@zaovra-ai/app/wsl/types"
import { availableStartupServer, createStartupServer, readyWslConnections } from "./connections"
import { createRoot, createSignal } from "solid-js"
import { isServer } from "solid-js/web"

test.skipIf(isServer)(
  "startup choice waits for initialization and does not change when WSL becomes ready later",
  () => {
    createRoot((dispose) => {
      const [ready, setReady] = createSignal(false)
      const [wsl, setWsl] = createSignal(state("starting"))
      const selected = createStartupServer({ ready, defaultServer: () => "wsl:Debian", wsl })
      expect(selected()).toBeUndefined()
      setReady(true)
      expect(selected()).toBe("sidecar")
      setWsl(state("ready"))
      expect(selected()).toBe("sidecar")
      dispose()
    })
  },
)

test.skipIf(isServer)("an initially ready WSL default retains its identity on connection failure", () => {
  createRoot((dispose) => {
    const [wsl, setWsl] = createSignal(state("ready"))
    const selected = createStartupServer({ ready: () => true, defaultServer: () => "wsl:Debian", wsl })
    expect(selected()).toBe("wsl:Debian")
    setWsl(state("failed"))
    expect(selected()).toBe("wsl:Debian")
    dispose()
  })
})

const state = (kind: "starting" | "ready" | "failed" | "stopped"): WslServersState => ({
  runtime: null,
  installed: [],
  online: [],
  distroProbes: {},
  zaovraChecks: {},
  pendingRestart: false,
  job: null,
  servers: [
    {
      config: { id: "wsl:Debian", distro: "Debian" },
      runtime: runtime(kind),
    },
  ],
})

function runtime(kind: "starting" | "ready" | "failed" | "stopped") {
  if (kind === "ready") return { kind, url: "http://127.0.0.1:4096", username: "zaovra", password: "secret" }
  if (kind === "failed") return { kind, message: "boom" }
  return { kind }
}

describe("WSL desktop connections", () => {
  test("publishes a WSL server only after it reports ready", () => {
    expect(readyWslConnections(state("starting"))).toEqual([])
    expect(readyWslConnections(state("failed"))).toEqual([])
    expect(readyWslConnections(state("stopped"))).toEqual([])
    expect(readyWslConnections(state("ready"))).toEqual([
      expect.objectContaining({ displayName: "Debian", label: "WSL" }),
    ])
  })

  test("does not block desktop startup on a configured WSL default", () => {
    const key = "wsl:Debian"
    expect(availableStartupServer(key, undefined)).toBe("sidecar")
    expect(availableStartupServer(key, state("starting"))).toBe("sidecar")
    expect(availableStartupServer(key, state("ready"))).toBe(key)
  })
})
