import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { PtyPaths } from "../../src/server/routes/instance/httpapi/groups/pty"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { PtyID } from "@zaovra-ai/core/pty/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

function app(input: { password?: string; username?: string }) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            ZAOVRA_SERVER_PASSWORD: input.password,
            ZAOVRA_SERVER_USERNAME: input.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler

  return {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input: string | URL | Request, init?: RequestInit) {
      return this.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
}

function basic(username: string, password: string) {
  return ServerAuth.header({ username, password }) ?? ""
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => {})
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi instance route authorization", () => {
  test("requires auth for filesystem reads that skip legacy bootstrap", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(`${tmp.path}/zaovra.json`, JSON.stringify({ permissions: [], mcp: { servers: {} }, skills: [] }))
    await Bun.write(`${tmp.path}/hello.txt`, "private content\n")
    const server = app({ password: "secret" })
    const headers = { "x-zaovra-directory": tmp.path }
    for (const route of [
      "/path",
      "/vcs",
      "/vcs/status",
      "/vcs/diff?mode=git",
      "/vcs/diff/raw",
      "/file?path=.",
      "/file/content?path=hello.txt",
      "/find?pattern=private",
      "/find/file?query=hello",
    ]) {
      const missing = await server.request(route, { headers })
      expect(missing.status).toBe(401)
      const authed = await server.request(route, {
        headers: { ...headers, authorization: basic("zaovra", "secret") },
      })
      expect(authed.status).toBe(200)
    }
    const missing = await server.request("/instance/dispose", { method: "POST", headers })
    expect(missing.status).toBe(401)
    const disposed = await server.request("/instance/dispose", {
      method: "POST",
      headers: { ...headers, authorization: basic("zaovra", "secret") },
    })
    expect(disposed.status).toBe(200)
  })

  test("authenticates native-config patch application before changing files", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(`${tmp.path}/zaovra.json`, JSON.stringify({ permissions: [], skills: [] }))
    await Bun.write(`${tmp.path}/hello.txt`, "before\n")
    const server = app({ password: "secret" })
    const headers = { "x-zaovra-directory": tmp.path, "content-type": "application/json" }
    const body = JSON.stringify({
      patch: "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-before\n+after\n",
    })
    const missing = await server.request("/vcs/apply", { method: "POST", headers, body })
    expect(missing.status).toBe(401)
    expect(await Bun.file(`${tmp.path}/hello.txt`).text()).toBe("before\n")
    const response = await server.request("/vcs/apply", {
      method: "POST",
      headers: { ...headers, authorization: basic("zaovra", "secret") },
      body,
    })
    expect(response.status).toBe(200)
    expect(await Bun.file(`${tmp.path}/hello.txt`).text()).toBe("after\n")
  })

  test("requires configured auth before opening the instance event stream", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await Bun.write(
      `${tmp.path}/zaovra.json`,
      JSON.stringify({ providers: {}, permissions: [], formatter: false, lsp: false }),
    )
    const server = app({ password: "secret" })
    const headers = { "x-zaovra-directory": tmp.path }

    const missing = await server.request(EventPaths.event, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(EventPaths.event, {
      headers: { ...headers, authorization: basic("zaovra", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(200)
  })

  test("requires configured auth before resolving the PTY websocket route", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const server = app({ password: "secret" })
    const route = PtyPaths.connect.replace(":ptyID", PtyID.ascending())
    const headers = { "x-zaovra-directory": tmp.path }

    const missing = await server.request(route, { headers })
    await cancelBody(missing)
    expect(missing.status).toBe(401)

    const authed = await server.request(route, {
      headers: { ...headers, authorization: basic("zaovra", "secret") },
    })
    await cancelBody(authed)
    expect(authed.status).toBe(404)
  })
})
