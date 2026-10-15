import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createEmbeddedSettings } from "../src/pages/layout/embedded-settings"
import { handleNotificationClick, setNavigate } from "../src/utils/notification-click"

test("embedded settings close on draft identity changes and same-route notifications", () => {
  let dispose = () => {}
  const [route, setRoute] = createStore({ pathname: "/new-session", search: "?draftId=a", hash: "" })
  const settings = createRoot((cleanup) => {
    dispose = cleanup
    return createEmbeddedSettings(
      () => true,
      () => route.pathname + route.search + route.hash,
    )
  })
  try {
    window.dispatchEvent(new CustomEvent("zaovra:settings-open", { detail: { sessionID: "a" } }))
    expect(settings.open).toBe(true)
    expect(settings.sessionID).toBe("a")
    setRoute("search", "?draftId=b")
    expect(settings.open).toBe(false)
    setNavigate(() => {})
    for (const kind of ["question", "permission"]) {
      for (let repeat = 0; repeat < 2; repeat++) {
        window.dispatchEvent(new CustomEvent("zaovra:settings-open"))
        expect(settings.open).toBe(true)
        handleNotificationClick(`/session/current#${kind}=same`)
        expect(settings.open).toBe(false)
      }
    }
  } finally {
    handleNotificationClick("/session/current")
    setNavigate(undefined)
    dispose()
  }
})
