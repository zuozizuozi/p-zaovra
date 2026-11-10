import { createZaovraClient, type VcsFileStatus } from "@zaovra-ai/sdk/v2"
import { createServer } from "node:http"

export async function reviewEntrySource() {
  const requests: string[] = []
  const responses = new Map<string, { files: VcsFileStatus[]; error?: boolean; wait?: Promise<void> }>()
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    response.setHeader("access-control-allow-origin", "*")
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type",
      })
      response.end()
      return
    }
    requests.push(url.pathname)
    if (url.pathname !== "/vcs/status") {
      response.writeHead(404)
      response.end("Unexpected patch request")
      return
    }
    const result = responses.get(url.searchParams.get("directory") ?? "")
    await result?.wait
    response.writeHead(result?.error ? 503 : 200, { "content-type": "application/json" })
    response.end(JSON.stringify(result?.error ? { message: "status temporarily unavailable" } : (result?.files ?? [])))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Review entry HTTP source did not bind a loopback port")
  return {
    requests,
    set: (directory: string, response: { files: VcsFileStatus[]; error?: boolean; wait?: Promise<void> }) =>
      responses.set(directory, response),
    client: (directory: string) => createZaovraClient({ baseUrl: `http://127.0.0.1:${address.port}`, directory }),
    stop: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

export const manualChange: VcsFileStatus[] = [{ file: "manual.txt", additions: 1, deletions: 0, status: "modified" }]

export async function untilReviewEntry(check: () => boolean) {
  const deadline = Date.now() + 3_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Review entry did not reach the expected state")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
