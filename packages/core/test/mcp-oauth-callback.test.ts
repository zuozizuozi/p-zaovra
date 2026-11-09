import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { Effect } from "effect"
import { ConfigMCP } from "../src/config/mcp"
import { implementation } from "../src/mcp/oauth"

async function fixture() {
  const port = createServer()
  await new Promise<void>((resolve) => port.listen(0, "127.0.0.1", resolve))
  const address = port.address()
  if (!address || typeof address === "string") throw new Error("missing callback port")
  await new Promise<void>((resolve) => port.close(() => resolve()))
  const calls: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      const origin = `http://127.0.0.1:${server.port}`
      calls.push(request.method + " " + url.pathname)
      if (url.pathname === "/mcp")
        return new Response("", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          },
        })
      if (url.pathname === "/.well-known/oauth-protected-resource")
        return Response.json({
          resource: origin + "/mcp",
          authorization_servers: [origin],
        })
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: origin,
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + "/token",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      if (url.pathname === "/token")
        return Response.json({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 })
      return new Response("Not found", { status: 404 })
    },
  })
  return {
    calls,
    callback: new URL(`http://127.0.0.1:${address.port}/mcp/oauth/callback`),
    config: new ConfigMCP.Remote({
      type: "remote",
      url: `http://127.0.0.1:${server.port}/mcp`,
      oauth: new ConfigMCP.OAuth({ client_id: "synthetic-client", callback_port: address.port }),
    }),
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

test("751 unrelated OAuth callbacks cannot settle the pending authorization", async () => {
  using local = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const authorization = yield* implementation("fixture", local.config).authorize({})
        if (authorization.mode !== "auto") throw new Error("expected automatic callback")
        const state = new URL(authorization.url).searchParams.get("state")
        expect(state).toBeTruthy()
        for (const query of ["code=unrelated", "state=wrong&code=unrelated", "state=wrong&error=access_denied"]) {
          const response = yield* Effect.promise(() => fetch(local.callback + "?" + query))
          expect(response.status).toBe(400)
          yield* Effect.promise(() => response.text())
        }
        const missing = yield* Effect.promise(() => fetch(local.callback + "?state=" + state))
        expect(missing.status).toBe(400)
        yield* Effect.promise(() => missing.text())
        const valid = yield* Effect.promise(() => fetch(local.callback + "?state=" + state + "&code=synthetic-code"))
        expect(valid.status).toBe(200)
        yield* Effect.promise(() => valid.text())
        const credential = yield* authorization.callback
        if (credential.type !== "oauth") throw new Error("expected OAuth credential")
        expect(credential.access).toBe("synthetic-access")
        expect(local.calls.filter((call) => call === "POST /token")).toHaveLength(1)
      }),
    ),
  )
  await expect(fetch(local.callback)).rejects.toThrow()
}, 10000)

test("751 matching OAuth state still propagates an explicit denial", async () => {
  using local = await fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const authorization = yield* implementation("fixture", local.config).authorize({})
        if (authorization.mode !== "auto") throw new Error("expected automatic callback")
        const state = new URL(authorization.url).searchParams.get("state")
        const denied = yield* Effect.promise(() => fetch(local.callback + "?state=" + state + "&error=access_denied"))
        yield* Effect.promise(() => denied.text())
        const result = yield* authorization.callback.pipe(Effect.flip)
        expect(String(result)).toContain("access_denied")
        expect(local.calls.filter((call) => call === "POST /token")).toHaveLength(0)
      }),
    ),
  )
  await expect(fetch(local.callback)).rejects.toThrow()
}, 10000)
