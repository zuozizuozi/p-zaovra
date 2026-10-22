import { afterAll, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"

afterAll(() => GlobalRegistrator.unregister())
const pending: {
  sessionID: string
  reference: string
  signal: AbortSignal
  resolve: (value: { data: string; mime: "image/png" }) => void
  reject: (error: Error) => void
}[] = []
const [source, setSource] = createSignal({
  key: "server-a",
  read: (sessionID: string, reference: string, signal: AbortSignal) =>
    new Promise<{ data: string; mime: "image/png" }>((resolve, reject) => {
      pending.push({ sessionID, reference, signal, resolve, reject })
    }),
})
mock.module("../../../session-ui/src/context", () => ({
  useData: () => ({ get screenshotSource() { return source() } }),
}))
mock.module("@zaovra-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: () => {} }) }))
mock.module("@zaovra-ai/ui/context/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
mock.module("@zaovra-ai/ui/image-preview", () => ({ ImagePreview: () => null }))
mock.module("../../../session-ui/src/components/markdown", () => ({ Markdown: () => null }))
mock.module("../../../session-ui/src/components/basic-tool", () => ({
  BasicTool: () => null,
  GenericTool: () => null,
}))

test("registered browser tool forwards session and managed reference only after completion", async () => {
  const { getTool } = await import("../../../session-ui/src/components/message-part")
  const component = getTool("browser")
  if (!component) throw new Error("Browser tool is not registered")
  const [status, setStatus] = createSignal("running")
  const count = pending.length
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(component, {
    tool: "browser", input: { action: "screenshot" }, sessionID: "ses_registered",
    metadata: { screenshot: { mime: "image/png", reference: "registered.png" } },
    get status() { return status() },
  }), host)
  try {
    expect(pending.length).toBe(count)
    setStatus("completed")
    expect(pending.length).toBe(count + 1)
    expect(pending[count].sessionID).toBe("ses_registered")
    expect(pending[count].reference).toBe("registered.png")
    pending[count].resolve({ data: "REGISTERED", mime: "image/png" })
    await Bun.sleep(0)
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,REGISTERED")
  } finally {
    dispose()
    host.remove()
    pending.splice(count)
  }
})

test("managed screenshot loads, retries, discards old-server responses and aborts on disposal", async () => {
  const { BrowserScreenshot } = await import("../../../session-ui/src/components/browser-screenshot")
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(() => createComponent(BrowserScreenshot, {
    sessionID: "ses_test",
    screenshot: { mime: "image/png", reference: "managed.png" },
  }), host)
  try {
    expect(host.textContent).toContain("loading")
    expect(pending[0].sessionID).toBe("ses_test")
    expect(pending[0].reference).toBe("managed.png")
    pending[0].reject(new Error("offline"))
    await Bun.sleep(0)
    expect(host.textContent).toContain("unavailable")
    host.querySelector("button")!.click()
    expect(pending.length).toBe(2)
    expect(pending[0].signal.aborted).toBe(true)
    setSource({ ...source(), key: "server-b" })
    expect(pending[1].signal.aborted).toBe(true)
    expect(pending.length).toBe(3)
    pending[1].resolve({ data: "OLD", mime: "image/png" })
    await Bun.sleep(0)
    expect(host.querySelector("img")).toBeNull()
    pending[2].resolve({ data: "NEW", mime: "image/png" })
    await Bun.sleep(0)
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,NEW")
  } finally {
    dispose()
    host.remove()
  }
  expect(pending[2].signal.aborted).toBe(true)
})

test("legacy inline screenshot stays readable and image failure offers retry", async () => {
  const { BrowserScreenshot } = await import("../../../session-ui/src/components/browser-screenshot")
  const host = document.createElement("div")
  document.body.append(host)
  const count = pending.length
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII="
  const dispose = render(() => createComponent(BrowserScreenshot, {
    sessionID: "ses_legacy",
    screenshot: { mime: "image/png", data: png },
  }), host)
  try {
    expect(host.querySelector("img")?.getAttribute("src")).toBe(`data:image/png;base64,${png}`)
    expect(pending.length).toBe(count)
    // HappyDOM does not decode pixels; exercise the browser's decode-error event path.
    host.querySelector("img")!.dispatchEvent(new Event("error"))
    expect(host.querySelector("img")).toBeNull()
    expect(host.textContent).toContain("unavailable")
    host.querySelector("button")!.click()
    expect(host.querySelector("img")?.getAttribute("src")).toBe(`data:image/png;base64,${png}`)
    expect(pending.length).toBe(count)
  } finally {
    dispose()
    host.remove()
  }
})

test.skipIf(!process.env.ZAOVRA_SCREENSHOT_NETWORK_A)("actual SDK reads isolated HTTP servers into the screenshot card", async () => {
  const { createZaovraClient } = await import("@zaovra-ai/sdk/v2/client")
  const { BrowserScreenshot } = await import("../../../session-ui/src/components/browser-screenshot")
  const connect = (baseUrl: string) => {
    const client = createZaovraClient({ baseUrl })
    setSource({ key: baseUrl, read: async (sessionID, reference, signal) => {
      const response = await client.v2.session.screenshot({ sessionID, reference }, { signal, throwOnError: true })
      if (!response.data) throw new Error("Missing screenshot")
      return response.data
    } })
  }
  const until = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (ready()) return
      await Bun.sleep(10)
    }
    throw new Error("Screenshot card did not settle")
  }
  const host = document.createElement("div")
  document.body.append(host)
  connect(process.env.ZAOVRA_SCREENSHOT_NETWORK_A!)
  const dispose = render(() => createComponent(BrowserScreenshot, {
    sessionID: process.env.ZAOVRA_SCREENSHOT_NETWORK_SESSION ?? "ses_http", screenshot: { mime: "image/png", reference: process.env.ZAOVRA_SCREENSHOT_NETWORK_ID! },
  }), host)
  try {
    await until(() => Boolean(host.querySelector("img")))
    const original = host.querySelector("img")!.getAttribute("src")
    expect(original).toStartWith("data:image/png;base64,iVBOR")
    connect(process.env.ZAOVRA_SCREENSHOT_NETWORK_B!)
    await until(() => Boolean(host.textContent?.includes("unavailable")))
    expect(host.querySelector("img")).toBeNull()
    host.querySelector("button")!.click()
    await until(() => Boolean(host.textContent?.includes("unavailable")))
    expect(host.querySelector("img")).toBeNull()
    connect(process.env.ZAOVRA_SCREENSHOT_NETWORK_A!)
    await until(() => Boolean(host.querySelector("img")))
    expect(host.querySelector("img")!.getAttribute("src")).toBe(original)
  } finally {
    dispose()
    host.remove()
  }
})
