import { afterAll, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createRoot } from "solid-js"
import { ServerScope } from "../../src/utils/server-scope"

afterAll(() => GlobalRegistrator.unregister())

const streams: ReadableStreamDefaultController<Uint8Array>[] = []
const signals: AbortSignal[] = []
const aborts: (() => void)[] = []
mock.module("../../src/context/platform", () => ({
  usePlatform: () => ({
    fetch: async (request: Request) => {
      signals.push(request.signal)
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller)
          const abort = () => controller.close()
          aborts.push(abort)
          request.signal.addEventListener("abort", abort, { once: true })
        },
      }), { headers: { "Content-Type": "text/event-stream" } })
    },
  }),
}))
mock.module("../../src/context/global", () => ({ useGlobal: () => undefined }))
mock.module("../../src/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))

async function until(predicate: () => boolean, attempts = 200) {
  for (let count = 0; count < attempts; count++) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("Transport lifecycle did not reach expected state")
}

function send(index: number, type: string) {
  streams[index].enqueue(new TextEncoder().encode(
    `data: ${JSON.stringify({ directory: "global", payload: { type, properties: {} } })}\n\n`,
  ))
}

test("real SDK SSE parsing clears connection state across EOF, reconnect, pagehide and disposal", async () => {
  const { createServerSdkContext } = await import("../../src/context/server-sdk")
  const state = createRoot((dispose) => ({
    dispose,
    sdk: createServerSdkContext({ type: "http", http: { url: "http://offline.invalid" } }, ServerScope.local),
  }))
  const connectedDuringDispatch: boolean[] = []
  const off = state.sdk.event.on("global", (event) => {
    if (event.type === "server.connected") connectedDuringDispatch.push(state.sdk.transportConnected())
  })
  try {
    expect(state.sdk.transportConnected()).toBe(false)
    void state.sdk.event.start()
    await until(() => streams.length === 1)
    send(0, "server.connected")
    await until(state.sdk.transportConnected)
    expect(connectedDuringDispatch).toEqual([false])
    streams[0].close()
    await until(() => !state.sdk.transportConnected())
    expect(state.sdk.transportConnected()).toBe(false)
    await until(() => streams.length === 2)
    expect(state.sdk.transportConnected()).toBe(false)
    send(1, "server.connected")
    await until(state.sdk.transportConnected)
    expect(connectedDuringDispatch).toEqual([false, false])
    window.dispatchEvent(new Event("pagehide"))
    expect(state.sdk.transportConnected()).toBe(false)
    await until(() => signals[1].aborted)
    expect(signals[1].aborted).toBe(true)
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }))
    await Bun.sleep(300)
    expect(streams.length).toBe(2)
    // HappyDOM omits PageTransitionEvent.persisted; supply the browser event property.
    const restored = new Event("pageshow")
    Object.defineProperty(restored, "persisted", { value: true })
    window.dispatchEvent(restored)
    await until(() => streams.length === 3)
    expect(state.sdk.transportConnected()).toBe(false)
    send(2, "server.connected")
    await until(state.sdk.transportConnected)
    expect(connectedDuringDispatch).toEqual([false, false, false])
    // A failed response body drives the real SDK onSseError/retry path.
    signals[2].removeEventListener("abort", aborts[2])
    streams[2].error(new Error("offline fixture connection lost"))
    await until(() => !state.sdk.transportConnected())
    expect(state.sdk.transportConnected()).toBe(false)
    await until(() => streams.length === 4)
    expect(state.sdk.transportConnected()).toBe(false)
    send(3, "server.connected")
    await until(state.sdk.transportConnected)
    expect(connectedDuringDispatch).toEqual([false, false, false, false])
    // Let the production 45-second heartbeat deadline expire without replacing timers.
    await until(() => signals[3].aborted, 4800)
    expect(state.sdk.transportConnected()).toBe(false)
    await until(() => streams.length === 5)
    send(4, "server.connected")
    await until(state.sdk.transportConnected)
    expect(connectedDuringDispatch).toEqual([false, false, false, false, false])
  } finally {
    off()
    state.dispose()
  }
  expect(state.sdk.transportConnected()).toBe(false)
  expect(signals[4].aborted).toBe(true)
  await Bun.sleep(300)
  expect(streams.length).toBe(5)
}, 60_000)
