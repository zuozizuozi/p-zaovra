import { expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"

// Isolated provider integration: only surrounding contexts are substituted.
// FileProvider, watcher, read queue, path normalization and content cache are real.
test("FileProvider watcher invalidation reads the new snapshot and retries deletion errors", async () => {
  const requests: ReturnType<typeof Promise.withResolvers<{ data: { type: "text"; content: string } }>>[] = []
  const notices: unknown[] = []
  let listener = (_event: { details: { type: string; properties: { file: string; event: string } } }) => {}
  const [directory, setDirectory] = createSignal("/project")
  const [server, setServer] = createSignal("local")
  const sdk = () => ({
    directory: directory(),
    client: { file: { read: () => {
      const request = Promise.withResolvers<{ data: { type: "text"; content: string } }>()
      requests.push(request)
      return request.promise
    } } },
    event: { listen: (next: typeof listener) => { listener = next; return () => {} } },
  })
  mock.module("@zaovra-ai/ui/context", () => ({ createSimpleContext: (options: { init: () => unknown }) => ({ provider: options.init }) }))
  mock.module("../../src/context/sdk", () => ({ useSDK: () => sdk }))
  mock.module("../../src/context/sync", () => ({ useSync: () => ({}) }))
  mock.module("../../src/context/server-sdk", () => ({ useServerSDK: () => () => ({ scope: server() }) }))
  mock.module("../../src/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
  mock.module("../../src/context/layout", () => ({ useLayout: () => ({ tabs: () => ({ all: () => [] }) }) }))
  mock.module("../../src/context/file/view-cache", () => ({ createFileViewCache: () => ({ load: () => ({}), clear: () => {} }) }))
  mock.module("../../src/utils/toast", () => ({ showToast: (notice: unknown) => notices.push(notice) }))
  mock.module("@solidjs/router", () => ({ useParams: () => ({}) }))
  const { FileProvider } = await import("../../src/context/file")
  type FileAPI = { load(path: string): Promise<void>; get(path: string): { loaded: boolean; content?: { content: string }; error?: string } }
  let dispose = () => {}
  const file = createRoot((cleanup) => {
    dispose = cleanup
    return (FileProvider as unknown as () => FileAPI)()
  })
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const event = (kind: string) => listener({ details: { type: "file.watcher.updated", properties: { file: "report.md", event: kind } } })
  try {
    const first = file.load("report.md")
    await flush()
    event("change")
    event("change")
    requests[0]!.resolve({ data: { type: "text", content: "before" } })
    await flush()
    expect(requests).toHaveLength(2)
    expect(file.get("report.md").content).toBeUndefined()
    requests[1]!.resolve({ data: { type: "text", content: "after" } })
    await first
    expect(file.get("report.md").content?.content).toBe("after")
    event("unlink")
    await flush()
    requests[2]!.reject(new Error("File missing"))
    await flush()
    expect(file.get("report.md").loaded).toBe(false)
    expect(file.get("report.md").content).toBeUndefined()
    expect(notices).toHaveLength(1)
    const retry = file.load("report.md")
    await flush()
    requests[3]!.resolve({ data: { type: "text", content: "recreated" } })
    await retry
    expect(file.get("report.md").content?.content).toBe("recreated")
    event("change")
    await flush()
    setDirectory("/other")
    requests[4]!.resolve({ data: { type: "text", content: "stale project" } })
    await flush()
    expect(file.get("report.md")).toBeUndefined()
    const previousServer = file.load("report.md")
    await flush()
    setServer("remote")
    const currentServer = file.load("report.md")
    await flush()
    requests[5]!.resolve({ data: { type: "text", content: "old server" } })
    await previousServer
    expect(file.get("report.md").content).toBeUndefined()
    requests[6]!.resolve({ data: { type: "text", content: "new server" } })
    await currentServer
    expect(file.get("report.md").content?.content).toBe("new server")
  } finally {
    dispose()
    mock.restore()
  }
})
