import { afterAll, expect, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"
import { EmptyBinaryBackground } from "../../src/components/session/empty-binary-background"

afterAll(() => GlobalRegistrator.unregister())

test("rain pauses on blur and reduced motion, resumes once and releases on unmount", async () => {
  const focus = spyOn(document, "hasFocus").mockReturnValue(true)
  const hidden = Object.getOwnPropertyDescriptor(document, "hidden")
  const visibility = { hidden: false }
  Object.defineProperty(document, "hidden", { configurable: true, get: () => visibility.hidden })
  const media = Object.assign(new EventTarget(), { matches: false })
  const query = spyOn(window, "matchMedia").mockReturnValue(media as MediaQueryList)
  const context = document.createElement("canvas").getContext("2d")!
  const clear = spyOn(context, "clearRect")
  const getContext = spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context)
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(EmptyBinaryBackground, {}), host)
  try {
    const initial = clear.mock.calls.length
    await Bun.sleep(190)
    expect(clear.mock.calls.length).toBeGreaterThan(initial)
    visibility.hidden = true
    document.dispatchEvent(new Event("visibilitychange"))
    const invisible = clear.mock.calls.length
    await Bun.sleep(190)
    expect(clear.mock.calls.length).toBe(invisible)
    visibility.hidden = false
    document.dispatchEvent(new Event("visibilitychange"))
    const visible = clear.mock.calls.length
    await Bun.sleep(190)
    expect(clear.mock.calls.length).toBeGreaterThan(visible)
    focus.mockReturnValue(false)
    window.dispatchEvent(new Event("blur"))
    const paused = clear.mock.calls.length
    await Bun.sleep(190)
    expect(clear.mock.calls.length).toBe(paused)
    focus.mockReturnValue(true)
    media.matches = true
    media.dispatchEvent(new Event("change"))
    window.dispatchEvent(new Event("focus"))
    const reduced = clear.mock.calls.length
    await Bun.sleep(190)
    expect(clear.mock.calls.length).toBe(reduced)
    media.matches = false
    media.dispatchEvent(new Event("change"))
    const resumed = clear.mock.calls.length
    await Bun.sleep(190)
    expect(clear.mock.calls.length - resumed).toBeGreaterThan(0)
    expect(clear.mock.calls.length - resumed).toBeLessThanOrEqual(3)
  } finally {
    dispose()
    host.remove()
  }
  const ended = clear.mock.calls.length
  window.dispatchEvent(new Event("focus"))
  media.dispatchEvent(new Event("change"))
  await Bun.sleep(190)
  expect(clear.mock.calls.length).toBe(ended)
  getContext.mockRestore()
  clear.mockRestore()
  query.mockRestore()
  focus.mockRestore()
  if (hidden) Object.defineProperty(document, "hidden", hidden)
  else Reflect.deleteProperty(document, "hidden")
})
