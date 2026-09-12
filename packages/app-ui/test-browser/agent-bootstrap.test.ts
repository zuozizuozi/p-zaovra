import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { QueryClient } from "@tanstack/solid-query"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { loadAgentsQuery } from "../src/context/global-sync/bootstrap"
import { ServerScope } from "../src/utils/server-scope"

test("agent bootstrap uses the executor API when legacy configuration cannot load", async () => {
  const paths: string[] = []
  const server = createServer((request, response) => {
    if (request.method === "GET") paths.push(request.url ?? "")
    response.setHeader("Content-Type", "application/json")
    response.setHeader("Access-Control-Allow-Origin", "*")
    if (request.url !== "/api/agent") {
      response.writeHead(400)
      response.end(JSON.stringify({ error: "legacy config" }))
      return
    }
    response.end(
      JSON.stringify({
        data: [
          {
            id: "v2-reviewer",
            mode: "primary",
            hidden: false,
            permissions: [],
            request: { headers: {}, body: {} },
            model: { id: "native-model", providerID: "native", variant: "deep" },
          },
        ],
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing HTTP address")
  const query = new QueryClient()
  try {
    const agents = await query.fetchQuery(
      loadAgentsQuery(
        ServerScope.local,
        "/project",
        createZaovraClient({ baseUrl: `http://127.0.0.1:${address.port}`, throwOnError: true }),
      ),
    )
    expect(agents).toMatchObject([
      { name: "v2-reviewer", model: { modelID: "native-model", providerID: "native" }, variant: "deep" },
    ])
    expect(paths).toEqual(["/api/agent"])
  } finally {
    query.clear()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

