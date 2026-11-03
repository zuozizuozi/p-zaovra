import { expect, test } from "bun:test"
import { join } from "node:path"
import { archiveFeedback } from "./archive-feedback"

test("Access archive preserves immutable originals, uses a header and rejects unsafe receipts", async () => {
  const root = process.env.ZAOVRA_WORKER_TEST_DIR
  if (!root) throw new Error("Use the current isolated record directory")
  const directory = join(root, "archive-" + crypto.randomUUID())
  const id = crypto.randomUUID()
  let unsafe = false
  let downloads = 0
  const original = {
    received: new Date().toISOString(),
    snapshot: { files: [{ name: "report.json", text: JSON.stringify({ reportID: id }) }] },
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(request.headers.get("cf-access-token")).toBe("fixture-token")
      if (new URL(request.url).pathname.endsWith("/reports"))
        return Response.json({ reports: [{ receipt: unsafe ? "../escape" : id }], cursor: null })
      downloads += 1
      return Response.json(original)
    },
  })
  const fetcher = (url: string | Request | URL, init?: RequestInit) =>
    fetch(new URL(new URL(String(url)).pathname, server.url), init)
  try {
    await expect(
      archiveFeedback({ token: "fixture-token", directory: join(root, "..", "escape"), archiveRoot: root, fetcher }),
    ).rejects.toThrow("Archive must stay inside")
    const first = await archiveFeedback({ token: "fixture-token", directory, archiveRoot: root, fetcher })
    expect(first).toHaveLength(1)
    expect(JSON.parse(await Bun.file(join(directory, id + ".json")).text())).toEqual(original)
    expect(await archiveFeedback({ token: "fixture-token", directory, archiveRoot: root, fetcher })).toHaveLength(0)
    expect(downloads).toBe(1)
    unsafe = true
    await expect(archiveFeedback({ token: "fixture-token", directory, archiveRoot: root, fetcher })).rejects.toThrow(
      "Invalid feedback receipt",
    )
  } finally {
    await server.stop(true)
  }
})
