import { createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"

import type { ServerConnection } from "@/context/server"

export function createEmbeddedSettings(desktop: () => boolean, route: () => string) {
  const [state, setState] = createStore<{
    open: boolean
    serverKey?: ServerConnection.Key
    sessionID?: string
    defaultValue?: string
  }>({ open: false })
  makeEventListener(window, "zaovra:settings-open", (event) => {
    if (!desktop() || !(event instanceof CustomEvent)) return
    event.preventDefault()
    setState({
      open: true,
      serverKey: event.detail?.serverKey,
      sessionID: event.detail?.sessionID,
      defaultValue: event.detail?.defaultValue,
    })
  })
  makeEventListener(window, "zaovra:settings-close", () => setState("open", false))
  createEffect(on(route, () => setState("open", false), { defer: true }))
  return state
}
