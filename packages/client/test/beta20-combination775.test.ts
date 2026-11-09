import { expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Provider } from "@zaovra-ai/schema/provider"
import { MCPConfig } from "@zaovra-ai/schema/mcp-config"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"

for (const kind of ["promise", "effect", "sdk"] as const)
  test(`775 ${kind} generated client retains model discovery and customization together`, async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = []
    const models = [{ id: "synthetic-concrete", name: "Synthetic" }]
    const info = { mcpEditable: true, skillsEditable: true, mcp: [], skills: [] }
    const location = { directory: "F:/synthetic775", project: { id: "proj_775", directory: "F:/synthetic775" } }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        const body = request.method === "PUT" ? await request.json() : undefined
        requests.push({ method: request.method, path, body })
        if (path === "/api/provider/synthetic/models") return Response.json({ location, data: models })
        if (path === "/api/customization") return Response.json({ location, data: info })
        if (request.method === "PUT") return new Response(null, { status: 204 })
        return new Response(null, { status: 404 })
      },
    })
    try {
      const baseUrl = server.url.origin
      if (kind === "promise") {
        const { Zaovra } = await import("../src")
        const client = Zaovra.make({ baseUrl })
        expect((await client.providers.models({ providerID: "synthetic" })).data).toEqual(models)
        expect((await client["server.customization"].list()).data).toEqual(info)
        await client["server.customization"].saveMCP({
          name: "local/combined",
          config: { type: "local", command: ["synthetic"], disabled: true },
        })
        await client["server.customization"].toggleSkill({ name: "skill/combined", enabled: false })
      }
      if (kind === "effect") {
        const { Zaovra } = await import("../src/effect")
        await Effect.gen(function* () {
          const client = yield* Zaovra.make({ baseUrl })
          expect((yield* client.providers.models({ providerID: Provider.ID.make("synthetic") })).data).toEqual(models)
          expect((yield* client["server.customization"].list()).data).toEqual(info)
          yield* client["server.customization"].saveMCP({
            name: "local/combined",
            config: new MCPConfig.Local({ type: "local", command: ["synthetic"], disabled: true }),
          })
          yield* client["server.customization"].toggleSkill({ name: "skill/combined", enabled: false })
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.tapError((error) =>
            Effect.sync(() => console.error("775 synthetic wire failure", error.cause, requests)),
          ),
          Effect.runPromise,
        )
      }
      if (kind === "sdk") {
        const client = createZaovraClient({ baseUrl })
        expect(
          (await client.v2.provider.models({ providerID: "synthetic" }, { throwOnError: true })).data?.data,
        ).toEqual(models)
        expect((await client.v2.customization.list(undefined, { throwOnError: true })).data?.data).toEqual(info)
        await client.v2.customization.saveMcp(
          {
            name: "local/combined",
            config: { type: "local", command: ["synthetic"], disabled: true },
          },
          { throwOnError: true },
        )
        await client.v2.customization.toggleSkill({ name: "skill/combined", enabled: false }, { throwOnError: true })
      }
      expect(requests).toEqual([
        { method: "GET", path: "/api/provider/synthetic/models", body: undefined },
        { method: "GET", path: "/api/customization", body: undefined },
        {
          method: "PUT",
          path: "/api/customization/mcp/local%2Fcombined",
          body: { config: { type: "local", command: ["synthetic"], disabled: true } },
        },
        { method: "PUT", path: "/api/customization/skill/skill%2Fcombined/enabled", body: { enabled: false } },
      ])
    } finally {
      await server.stop(true)
    }
  })
