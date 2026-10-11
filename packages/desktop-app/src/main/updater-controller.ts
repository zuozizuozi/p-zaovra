import type { UpdaterState } from "@zaovra-ai/app/updater"

export type { UpdaterState } from "@zaovra-ai/app/updater"

export type UpdaterReadyRecord = { version: string }

export type UpdaterBackend = {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null | undefined>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void | Promise<void>
}

type UpdaterPersistence = {
  get(): UpdaterReadyRecord | undefined | Promise<UpdaterReadyRecord | undefined>
  set(value: UpdaterReadyRecord): void | Promise<void>
  clear(): void | Promise<void>
}

export function createUpdaterController(input: {
  enabled: boolean
  currentVersion: string
  backend: UpdaterBackend
  persistence: UpdaterPersistence
  automatic?: {
    get(): boolean
    set(enabled: boolean): void
    lastCheck(): number
    recordCheck(time: number): void
  }
  now?: () => number
  log?: (message: string, data?: object) => void
}) {
  let state: UpdaterState = input.enabled ? { status: "idle" } : { status: "disabled" }
  let pending: Promise<UpdaterState> | undefined
  const listeners = new Set<(state: UpdaterState) => void>()
  const now = input.now ?? Date.now
  const day = 24 * 60 * 60 * 1000
  let timer: ReturnType<typeof setTimeout> | undefined

  const transition = (next: UpdaterState) => {
    input.log?.("updater state changed", { from: state.status, to: next.status })
    state = next
    listeners.forEach((listener) => listener(state))
    return state
  }

  const check = () => {
    if (!input.enabled) return Promise.resolve(state)
    if (state.status === "ready" || state.status === "installing") return Promise.resolve(state)
    if (pending) return pending

    pending = (async () => {
      transition({ status: "checking" })
      input.automatic?.recordCheck(now())
      const result = await input.backend.checkForUpdates()
      const version = result?.updateInfo?.version
      if (!result?.isUpdateAvailable || !version || version === input.currentVersion) {
        await input.persistence.clear()
        return transition({ status: "up-to-date" })
      }

      return transition({ status: "available", version })
    })()
      .catch((error) =>
        transition({ status: "error", message: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  const checkAutomatically = () => {
    if (!input.enabled || !input.automatic?.get() || now() - input.automatic.lastCheck() < day)
      return Promise.resolve(state)
    return check()
  }
  const schedule = () => {
    clearTimeout(timer)
    if (!input.enabled || !input.automatic?.get()) return
    timer = setTimeout(
      () => {
        void checkAutomatically().finally(schedule)
      },
      Math.max(30_000, day - (now() - input.automatic.lastCheck())),
    )
    timer.unref?.()
  }

  return {
    getState: () => state,
    subscribe(listener: (state: UpdaterState) => void) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    async start() {
      const ready = await input.persistence.get()
      if (ready?.version === input.currentVersion) await input.persistence.clear()
      schedule()
      return state
    },
    autoCheck: () => input.automatic?.get() ?? false,
    setAutoCheck(enabled: boolean) {
      input.automatic?.set(enabled)
      schedule()
      return input.automatic?.get() ?? false
    },
    stop: () => clearTimeout(timer),
    checkAutomatically,
    check,
    download() {
      if (pending) return pending
      if (state.status !== "available") return Promise.resolve(state)
      const version = state.version
      transition({ status: "downloading", version })
      pending = Promise.resolve()
        .then(() => input.backend.downloadUpdate())
        .then(() => input.persistence.set({ version }))
        .then(() => transition({ status: "ready", version }))
        .catch((error) =>
          transition({ status: "error", message: error instanceof Error ? error.message : String(error) }),
        )
        .finally(() => {
          pending = undefined
        })
      return pending
    },
    async install() {
      if (state.status !== "ready") throw new Error("Update is not ready to install")
      const version = state.version
      transition({ status: "installing", version })
      await Promise.resolve()
        .then(() => input.backend.quitAndInstall())
        .catch((error) => {
          transition({ status: "ready", version })
          throw error
        })
    },
  }
}

export type UpdaterController = ReturnType<typeof createUpdaterController>
