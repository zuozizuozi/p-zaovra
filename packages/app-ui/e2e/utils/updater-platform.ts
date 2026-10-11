import { createStore } from "solid-js/store"
import type { UpdaterPlatform, UpdaterState } from "../../src/updater"

// Only injected by updater-vite.config.ts; never included in the application entry.
const [store, setStore] = createStore<{ state: UpdaterState }>({ state: { status: "idle" } })
window.addEventListener("test:updater", (event) => setStore("state", (event as CustomEvent<UpdaterState>).detail))
export const updater: UpdaterPlatform = {
  state: () => store.state,
  async check() {
    const state: UpdaterState = { status: "available", version: "2.0.0" }
    setStore("state", state)
    return state
  },
  async download() {
    setStore("state", { status: "downloading", version: "2.0.0" })
    const state: UpdaterState = await fetch("/test-updater/download", { method: "POST" }).then((response) =>
      response.json(),
    )
    setStore("state", state)
    return state
  },
  async install() {
    await fetch("/test-updater/install", { method: "POST" })
  },
}
