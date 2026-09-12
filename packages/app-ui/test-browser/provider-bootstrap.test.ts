import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { QueryClient } from "@tanstack/solid-query"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { loadProvidersQuery } from "../src/context/global-sync/bootstrap"
import { ServerScope } from "../src/utils/server-scope"

test("model selection uses the executor catalog while retaining connection discovery", async () => {
  const requests: string[] = []
  const model = {
    id: "native-model",
    providerID: "native",
    name: "Native model",
    api: { type: "native", id: "native-model", settings: {} },
    capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
    request: { body: {}, headers: {} },
    variants: [{ id: "deep", body: { effort: "high" }, headers: {} }],
    cost: [{ input: 2, output: 8, cache: { read: 0.2, write: 2 } }],
    time: { released: 0 },
    status: "active",
    enabled: true,
    limit: { context: 32000, output: 2000 },
  }
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json")
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "*")
    if (request.method === "OPTIONS") {
      response.end()
      return
    }
    requests.push(request.url ?? "")
    const pathname = new URL(request.url!, "http://localhost").pathname
    if (pathname === "/api/provider") {
      response.end(JSON.stringify({ data: [{ id: "native", name: "Native", api: model.api, request: model.request }] }))
      return
    }
    if (pathname === "/api/model") {
      response.end(
        JSON.stringify({
          data: [model, { ...model, id: "disabled", enabled: false }, { ...model, id: "old", status: "deprecated" }],
        }),
      )
      return
    }
    if (pathname === "/api/integration") {
      response.end(
        JSON.stringify({
          data: [
            { id: "disconnected", name: "Connect me", methods: [{ type: "key" }], connections: [] },
            { id: "native", name: "Native", methods: [{ type: "key" }], connections: [] },
          ],
        }),
      )
      return
    }
    response.writeHead(400)
    response.end(JSON.stringify({ error: "legacy configuration cannot load" }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing HTTP address")
  const query = new QueryClient()
  try {
    const catalog = await query.fetchQuery(
      loadProvidersQuery(
        ServerScope.local,
        "/project",
        createZaovraClient({
          baseUrl: `http://127.0.0.1:${address.port}`,
          directory: "/project",
          throwOnError: true,
        }),
      ),
    )
    expect(requests.map((request) => new URL(request, "http://localhost").pathname).sort()).toEqual([
      "/api/integration",
      "/api/model",
      "/api/provider",
    ])
    expect(
      requests.every(
        (request) => new URL(request, "http://localhost").searchParams.get("location[directory]") === "/project",
      ),
    ).toBe(true)
    expect(catalog.connected).toEqual(["native"])
    expect(catalog.all.get("native")?.source).toBe("config")
    expect(catalog.all.get("disconnected")?.name).toBe("Connect me")
    expect(Object.keys(catalog.all.get("native")?.models ?? {})).toEqual(["native-model"])
    expect(catalog.all.get("native")?.models["native-model"]).toMatchObject({
      capabilities: { toolcall: true, input: { image: true, pdf: true, audio: false } },
      cost: { input: 2, output: 8 },
      variants: { deep: { effort: "high" } },
      release_date: "",
      limit: { context: 32000, output: 2000 },
    })
  } finally {
    query.clear()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
