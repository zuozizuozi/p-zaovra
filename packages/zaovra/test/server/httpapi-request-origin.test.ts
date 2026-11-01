import { describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"

function app(input: { hostname?: string; password?: string; cors?: string[] } = {}) {
  const web = HttpRouter.toWebHandler(
    HttpApiApp.createRoutes(input).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ ZAOVRA_SERVER_PASSWORD: input.password }))),
    ),
    { disableLogger: true },
  )
  return {
    fetch: (route: string, headers: Record<string, string | undefined> = {}, method = "GET") =>
      web.handler(
        new Request(`http://localhost${route}`, {
          headers: Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
          method,
        }),
        HttpApiApp.context,
      ),
    [Symbol.asyncDispose]: () => web.dispose(),
  }
}

describe("490 unprotected Host and Origin defense", () => {
  test("rejects rebinding, forged proxies and hostile origins before HTTP, event or PTY dispatch", async () => {
    await using server = app()
    for (const headers of [
      { host: "attacker.example:4096" },
      { host: "attacker.example:4096", origin: "http://attacker.example:4096" },
      { host: "attacker.example", forwarded: "host=localhost", "x-forwarded-host": "localhost" },
      { host: "localhost:4096", origin: "https://attacker.example" },
      { host: "localhost:4096", origin: "http://localhost:4096@attacker.example" },
      { host: "localhost:4096", origin: "http://localhost:4096.attacker.example" },
      { host: "localhost:4096", origin: "null" },
      { host: "[::1]:4096", origin: "https://attacker.example" },
      { host: "localhost:0" },
    ]) {
      for (const route of [
        "/global/health",
        "/event",
        "/global/event",
        "/pty/not-owned/connect?ticket=forged",
        "/api/pty/not-owned/connect?ticket=forged",
      ]) {
        const response = await server.fetch(route, {
          ...headers,
          ...(route.includes("/connect") ? { upgrade: "websocket", connection: "Upgrade" } : {}),
        })
        try {
          expect(response.status).toBe(403)
        } finally {
          await response.body?.cancel()
        }
      }
    }
    const preflight = await server.fetch(
      "/api/session",
      { host: "attacker.example", origin: "https://attacker.example", "access-control-request-method": "POST" },
      "OPTIONS",
    )
    expect(preflight.status).toBe(403)
    await preflight.body?.cancel()
  })

  test("preserves legitimate no-Origin CLI, exact IPv6/port and configured proxy authority", async () => {
    await using server = app({ hostname: "work.example", cors: ["https://ui.example"] })
    for (const headers of [
      {},
      { host: "localhost:4096" },
      { host: "[::1]:4096", origin: "http://[::1]:4096" },
      { host: "192.0.2.10:4096", origin: "http://192.0.2.10:4096" },
      { host: "work.example:4096", origin: "https://work.example:4096" },
      { host: "work.example:4096", origin: "https://ui.example", forwarded: "host=ignored.example" },
      { host: "zaovra.internal" },
    ]) {
      for (const route of ["/global/health", "/api/session/active"]) {
        const response = await server.fetch(route, headers)
        expect(response.status).toBe(200)
        if (route === "/global/health") expect((await response.json()).healthy).toBe(true)
        else expect((await response.json()).data).toEqual({})
      }
    }
  })

  test("keeps configured password authentication as the desktop boundary", async () => {
    await using server = app({ password: "fixture-random-password" })
    const headers = { host: "desktop.example", origin: "https://desktop.example" }
    const missing = await server.fetch("/global/health", headers)
    expect(missing.status).toBe(401)
    await missing.body?.cancel()
    const authorized = await server.fetch("/global/health", {
      ...headers,
      authorization: ServerAuth.header({ password: "fixture-random-password" })!,
    })
    expect(authorized.status).toBe(200)
    await authorized.body?.cancel()
  })
})
