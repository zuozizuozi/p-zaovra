import { describe, expect, test } from "bun:test"
import { createUpdaterController, type UpdaterBackend, type UpdaterReadyRecord } from "./updater-controller"

function setup(input?: { currentVersion?: string; ready?: UpdaterReadyRecord }) {
  const calls: string[] = []
  const backend: UpdaterBackend = {
    async checkForUpdates() {
      calls.push("check")
      return { isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }
    },
    async downloadUpdate() {
      calls.push("download")
    },
    quitAndInstall() {
      calls.push("install")
    },
  }
  let ready = input?.ready
  const controller = createUpdaterController({
    enabled: true,
    currentVersion: input?.currentVersion ?? "1.0.0",
    backend,
    persistence: {
      get: () => ready,
      set: (value) => {
        ready = value
      },
      clear: () => {
        ready = undefined
      },
    },
  })
  return { controller, calls, getReady: () => ready }
}

describe("updater controller", () => {
  test("never downloads without consent, including a persisted target, and coalesces downloads", async () => {
    const app = setup({ ready: { version: "2.0.0" } })
    await app.controller.start()
    expect(app.calls).toEqual([])
    expect(await app.controller.check()).toEqual({ status: "available", version: "2.0.0" })
    expect(app.calls).toEqual(["check"])
    await expect(app.controller.install()).rejects.toThrow("not ready")
    await Promise.all([app.controller.download(), app.controller.download(), app.controller.check()])
    expect(app.calls).toEqual(["check", "download"])
    expect(app.controller.getState().status).toBe("ready")
  })
  test("does not check or download again while installation is waiting for acceptance", async () => {
    const stopped = Promise.withResolvers<void>()
    const calls: string[] = []
    const controller = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        async checkForUpdates() {
          calls.push("check")
          return { isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }
        },
        async downloadUpdate() {
          calls.push("download")
        },
        quitAndInstall() {
          calls.push("install")
          return stopped.promise
        },
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
    })
    await controller.check()
    await controller.download()
    const installing = controller.install()
    try {
      expect(await controller.check()).toEqual({ status: "installing", version: "2.0.0" })
      expect(calls).toEqual(["check", "download", "install"])
    } finally {
      stopped.resolve()
      await installing
    }
    expect(calls).toEqual(["check", "download", "install"])
  })

  test("checks, downloads, persists, and publishes one authoritative ready state", async () => {
    const app = setup()
    const states: ReturnType<typeof app.controller.getState>[] = []
    app.controller.subscribe((state) => states.push(state))

    await app.controller.start()
    expect(app.calls).toEqual([])
    await app.controller.check()
    await app.controller.download()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.getReady()).toEqual({ version: "2.0.0" })
    expect(states.map((state) => state.status)).toEqual(["idle", "checking", "available", "downloading", "ready"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("revalidates a persisted target only after explicit check and download", async () => {
    const app = setup({ ready: { version: "2.0.0" } })

    await app.controller.start()
    expect(app.calls).toEqual([])
    await app.controller.check()
    await app.controller.download()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("clears a target already installed before checking", async () => {
    const app = setup({ currentVersion: "2.0.0", ready: { version: "2.0.0" } })

    await app.controller.start()
    expect(app.calls).toEqual([])
    await app.controller.check()
    await app.controller.download()

    expect(app.getReady()).toBeUndefined()
    expect(app.calls).toEqual(["check"])
  })

  test("coalesces concurrent checks", async () => {
    const app = setup()

    await Promise.all([app.controller.check(), app.controller.check(), app.controller.check()])

    expect(app.calls).toEqual(["check"])
  })

  test("stays installing after the installer accepts the update", async () => {
    const app = setup()
    await app.controller.start()
    expect(app.calls).toEqual([])
    await app.controller.check()
    await app.controller.download()

    await app.controller.install()

    expect(app.calls).toEqual(["check", "download", "install"])
    expect(app.controller.getState()).toEqual({ status: "installing", version: "2.0.0" })
  })

  test("returns to ready when installation cannot start", async () => {
    const app = setup()
    await app.controller.start()
    expect(app.calls).toEqual([])
    await app.controller.check()
    await app.controller.download()

    const failed = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }),
        downloadUpdate: async () => {},
        quitAndInstall() {
          throw new Error("installer failed")
        },
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
    })
    await failed.start()
    await failed.check()
    await failed.download()

    await expect(failed.install()).rejects.toThrow("installer failed")
    expect(failed.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })
})
