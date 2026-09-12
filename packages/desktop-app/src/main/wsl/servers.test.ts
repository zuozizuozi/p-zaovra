import { expect, test } from "bun:test"
import {
  clearWslDistroState,
  requireWslIpcString,
  requireWslIpcStrings,
  wslServerIdToRestart,
  wslTerminalArgs,
} from "./policy"
import {
  expectZaovraVersion,
  pendingRestartAfterWslInstall,
  pollWslHealth,
  wslServerIdsToStartOnInitialize,
} from "./startup"
import { createWslServersController, type WslServerConfig } from "./servers"

let persistedServers: WslServerConfig[] = []
let releaseZaovraResolve: (() => void) | undefined

test("starts every configured WSL server on initialization", () => {
  expect(
    wslServerIdsToStartOnInitialize([
      { id: "wsl:Debian", distro: "Debian" },
      { id: "wsl:Ubuntu-24.04", distro: "Ubuntu-24.04" },
    ]),
  ).toEqual(["wsl:Debian", "wsl:Ubuntu-24.04"])
})

test("rejects an update that did not install the desktop version", () => {
  expect(() => expectZaovraVersion("1.16.2", "1.16.2")).not.toThrow()
  expect(() => expectZaovraVersion("1.14.35", "1.16.2")).toThrow(
    "Zaovra update finished but Debian still reports 1.14.35; expected 1.16.2",
  )
})

test("restarts an existing distro server after updating Zaovra", () => {
  expect(
    wslServerIdToRestart(
      [
        {
          config: { id: "wsl:Debian", distro: "Debian" },
          runtime: { kind: "ready", url: "", username: null, password: null },
        },
      ],
      "Debian",
    ),
  ).toBe("wsl:Debian")
  expect(wslServerIdToRestart([], "Debian")).toBeUndefined()
})

test("clears cached distro probes when removing a WSL server", () => {
  expect(
    clearWslDistroState(
      { Debian: { name: "Debian", canExecute: true, hasBash: true, hasCurl: true, error: null } },
      {
        Debian: {
          distro: "Debian",
          resolvedPath: "/home/luke/.zaovra/bin/zaovra",
          version: "1.16.2",
          expectedVersion: "1.16.2",
          matchesDesktop: true,
          error: null,
        },
      },
      "Debian",
    ),
  ).toEqual({ distroProbes: {}, zaovraChecks: {} })
})

test("opens terminals for distro names containing spaces", () => {
  expect(wslTerminalArgs("Ubuntu Preview")).toEqual(["/c", "start", "", "wsl", "-d", "Ubuntu Preview"])
})

test("stops health polling when sidecar startup settles", async () => {
  const abort = new AbortController()
  let checks = 0
  const polling = pollWslHealth(
    async () => {
      checks++
      return false
    },
    abort.signal,
    1,
  )

  await new Promise((resolve) => setTimeout(resolve, 5))
  abort.abort()
  await polling
  const settled = checks
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(checks).toBe(settled)
})

test("validates WSL IPC identifiers at the module boundary", () => {
  expect(requireWslIpcString("distro", "Debian")).toBe("Debian")
  expect(requireWslIpcStrings("distro", ["Debian", "Ubuntu"])).toEqual(["Debian", "Ubuntu"])
  expect(() => requireWslIpcString("distro", "")).toThrow("Invalid distro")
  expect(() => requireWslIpcString("server id", undefined)).toThrow("Invalid server id")
  expect(() => requireWslIpcStrings("distro", [])).toThrow("Invalid distro")
})

test("derives a required Windows restart from the post-install runtime probe", () => {
  expect(pendingRestartAfterWslInstall({ available: false, version: null, error: "WSL unavailable" })).toBe(true)
  expect(pendingRestartAfterWslInstall({ available: true, version: "WSL version: 2.6.1", error: null })).toBe(false)
})

test("ignores stale background Zaovra checks after removing a WSL server", async () => {
  persistedServers = []
  releaseZaovraResolve = undefined
  const controller = createWslServersController(
    "1.16.2",
    async () => ({
      listener: {
        stop: () => undefined,
        onExit: () => undefined,
      },
      url: "http://127.0.0.1:4096",
      username: "zaovra",
      password: "secret",
    }),
    testControllerOptions(),
  )

  await controller.addServer("Debian")
  await waitFor(() => !!releaseZaovraResolve)
  await controller.removeServer("wsl:Debian")
  releaseZaovraResolve?.()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(controller.getState().servers).toEqual([])
  expect(controller.getState().zaovraChecks).toEqual({})
})

test("ignores stale startup Zaovra checks after removing a WSL server", async () => {
  persistedServers = [{ id: "wsl:Debian", distro: "Debian" }]
  releaseZaovraResolve = undefined
  const controller = createWslServersController(
    "1.16.2",
    async () => new Promise<never>(() => undefined),
    testControllerOptions(),
  )

  await controller.initialize()
  await waitFor(() => !!releaseZaovraResolve)
  await controller.removeServer("wsl:Debian")
  releaseZaovraResolve?.()
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(controller.getState().servers).toEqual([])
  expect(controller.getState().zaovraChecks).toEqual({})
})

test("probes addable distros in parallel before checking Zaovra", async () => {
  persistedServers = []
  const started: string[] = []
  const release = new Map<string, () => void>()
  const zaovra: string[] = []
  const controller = createWslServersController("1.16.2", async () => new Promise<never>(() => undefined), {
    ...testControllerOptions(),
    probeDistro: async (distro) => {
      started.push(distro)
      await new Promise<void>((resolve) => release.set(distro, resolve))
      return { name: distro, canExecute: true, hasBash: true, hasCurl: true, error: null }
    },
    resolveZaovra: async (distro) => {
      zaovra.push(distro)
      return "/home/me/.zaovra/bin/zaovra"
    },
  })

  const task = controller.probeAddable(["Debian", "Ubuntu"])
  await waitFor(() => started.length === 2)
  expect(started).toEqual(["Debian", "Ubuntu"])
  expect(zaovra).toEqual([])
  release.get("Debian")?.()
  release.get("Ubuntu")?.()
  await task

  expect(Object.keys(controller.getState().distroProbes)).toEqual(["Debian", "Ubuntu"])
  expect(zaovra).toEqual(["Debian", "Ubuntu"])
  expect(Object.keys(controller.getState().zaovraChecks)).toEqual(["Debian", "Ubuntu"])
})

test("does not check Zaovra in addable distros that cannot execute commands", async () => {
  persistedServers = []
  const zaovra: string[] = []
  const controller = createWslServersController("1.16.2", async () => new Promise<never>(() => undefined), {
    ...testControllerOptions(),
    probeDistro: async (distro) => ({
      name: distro,
      canExecute: distro === "Debian",
      hasBash: distro === "Debian",
      hasCurl: distro === "Debian",
      error: distro === "Debian" ? null : "Open Ubuntu once to finish setup",
    }),
    resolveZaovra: async (distro) => {
      zaovra.push(distro)
      return "/home/me/.zaovra/bin/zaovra"
    },
  })

  await controller.probeAddable(["Debian", "Ubuntu"])

  expect(Object.keys(controller.getState().distroProbes)).toEqual(["Debian", "Ubuntu"])
  expect(zaovra).toEqual(["Debian"])
  expect(Object.keys(controller.getState().zaovraChecks)).toEqual(["Debian"])
})

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("Timed out waiting for condition")
}

test("shutdown waits for startup and stale sidecar cleanup", async () => {
  persistedServers = []
  const spawned = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  let spawns = 0
  let stops = 0
  const controller = createWslServersController(
    "1.16.2",
    async () => {
      spawns++
      await spawned.promise
      return {
        listener: {
          stop: () => {
            stops++
            return stopped.promise
          },
          onExit: () => undefined,
        },
        url: "http://127.0.0.1:4096",
        username: null,
        password: "fixture",
      }
    },
    testControllerOptions(),
  )
  await controller.addServer("Debian")
  await waitFor(() => spawns === 1)
  let finished = false
  const pending = controller.stopAll()
  expect(controller.stopAll()).toBe(pending)
  void pending.then(() => {
    finished = true
  })
  await Bun.sleep(0)
  expect(finished).toBe(false)
  spawned.resolve()
  await waitFor(() => stops === 1)
  expect(finished).toBe(false)
  stopped.resolve()
  await pending
  expect(finished).toBe(true)
  expect(stops).toBe(1)
  await controller.startServer("wsl:Debian")
  expect(spawns).toBe(1)
})

test("shutdown retains failed cleanup for a later retry", async () => {
  persistedServers = []
  let stops = 0
  const controller = createWslServersController(
    "1.16.2",
    async () => ({
      listener: {
        stop: async () => {
          if (++stops === 1) throw new Error("cleanup failed")
        },
        onExit: () => undefined,
      },
      url: "http://127.0.0.1:4096",
      username: null,
      password: "fixture",
    }),
    testControllerOptions(),
  )
  await controller.addServer("Debian")
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")
  await expect(controller.stopAll()).rejects.toThrow("cleanup failed")
  await controller.stopAll()
  expect(stops).toBe(2)
})

test("restarting does not spawn a replacement when the old server cannot stop", async () => {
  persistedServers = []
  let spawns = 0
  let stops = 0
  const controller = createWslServersController(
    "1.16.2",
    async () => {
      spawns++
      return {
        listener: {
          stop: async () => {
            if (++stops === 1) throw new Error("old server still running")
          },
          onExit: () => undefined,
        },
        url: "http://127.0.0.1:4096",
        username: null,
        password: "fixture",
      }
    },
    testControllerOptions(),
  )
  await controller.addServer("Debian")
  await waitFor(() => controller.getState().servers[0]?.runtime.kind === "ready")
  await controller.startServer("wsl:Debian")
  expect(spawns).toBe(1)
  expect(controller.getState().servers[0]?.runtime).toEqual({ kind: "failed", message: "old server still running" })
  await controller.stopAll()
  expect(stops).toBe(2)
})

function testControllerOptions() {
  return {
    readServers: () => persistedServers,
    writeServers: (servers: WslServerConfig[]) => {
      persistedServers = servers
    },
    readCommandVersion: async () => "1.16.2",
    resolveZaovra: async () => {
      await new Promise<void>((resolve) => {
        releaseZaovraResolve = resolve
      })
      return "/home/me/.zaovra/bin/zaovra"
    },
  }
}
