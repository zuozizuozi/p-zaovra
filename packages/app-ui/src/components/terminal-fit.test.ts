import { afterEach, expect, test } from "bun:test"
import { FitAddon } from "ghostty-web"
import type { Terminal } from "ghostty-web"
import { observeTerminalFit } from "./terminal-fit"

const cleanup: Array<() => void> = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((stop) => stop()),
)

// The fit runs on a 75ms timer plus one animation frame; a loaded machine can take longer than any fixed wait.
async function fitted(calls: unknown[], count: number) {
  const deadline = Date.now() + 5000
  while (calls.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
}

function fixture() {
  const element = document.createElement("div")
  document.body.append(element)
  const geometry = { width: 0, height: 0 }
  Object.defineProperties(element, {
    clientWidth: { get: () => geometry.width },
    clientHeight: { get: () => geometry.height },
  })
  const terminal = {
    element,
    cols: 80,
    rows: 24,
    renderer: { getMetrics: () => ({ width: 9, height: 18 }) },
    resize(cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
    },
  }
  // Real Ghostty fit calculations; only WASM terminal rendering and DOM geometry are outside this test.
  const addon = new FitAddon()
  addon.activate(terminal as unknown as Terminal)
  const calls: Array<[number, number]> = []
  const fitting = observeTerminalFit(element, () => {
    addon.fit()
    calls.push([terminal.cols, terminal.rows])
  })
  cleanup.push(
    () => element.remove(),
    () => addon.dispose(),
    fitting.dispose,
  )
  return { element, geometry, terminal, calls, fitting }
}

test("hidden initial terminal does not fit or publish a tiny PTY; visible narrow host fits", async () => {
  const f = fixture()
  f.fitting.fit()
  f.fitting.schedule()
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(f.calls).toEqual([])
  expect(f.terminal.cols).toBe(80)
  f.geometry.width = 600
  f.geometry.height = 240
  f.fitting.schedule()
  await fitted(f.calls, 1)
  expect(f.terminal.cols).toBeGreaterThan(50)
  expect(f.terminal.rows).toBeGreaterThan(10)
  expect(f.calls).toHaveLength(1)
})

test("grow during Ghostty's resize suppression is retried after layout settles", async () => {
  const f = fixture()
  f.geometry.width = 18
  f.geometry.height = 200
  f.fitting.fit()
  expect(f.terminal.cols).toBeLessThan(5)
  f.geometry.width = 465
  window.dispatchEvent(new Event("resize"))
  await fitted(f.calls, 2)
  expect(f.terminal.cols).toBeGreaterThan(45)
  expect(f.calls).toHaveLength(2)
})

test("font/zoom fits coalesce and cleanup cancels queued fits", async () => {
  const f = fixture()
  f.geometry.width = 465
  f.geometry.height = 250
  f.fitting.fit()
  expect(f.terminal.cols).toBeGreaterThan(45)
  f.geometry.width = 820
  f.fitting.schedule()
  f.fitting.schedule()
  await fitted(f.calls, 2)
  expect(f.terminal.cols).toBeGreaterThan(85)
  expect(f.calls).toHaveLength(2)
  f.fitting.schedule()
  window.dispatchEvent(new Event("resize"))
  f.fitting.dispose()
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(f.calls).toHaveLength(2)
})

test("container-only ResizeObserver changes refit without a window resize", async () => {
  let notify = () => {}
  let observed: Element | undefined
  let disconnected = false
  // HappyDOM has no layout engine; driving this platform callback is the only mocked boundary.
  const original = globalThis.ResizeObserver
  globalThis.ResizeObserver = class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      notify = () => callback([], this)
    }
    observe(target: Element) {
      observed = target
    }
    unobserve() {}
    disconnect() {
      disconnected = true
    }
  }
  cleanup.push(() => {
    globalThis.ResizeObserver = original
  })
  const f = fixture()
  expect(observed).toBe(f.element)
  f.geometry.width = 465
  f.geometry.height = 250
  f.fitting.fit()
  f.geometry.width = 820
  notify()
  await fitted(f.calls, 2)
  expect(f.terminal.cols).toBeGreaterThan(85)
  f.fitting.dispose()
  expect(disconnected).toBe(true)
})
