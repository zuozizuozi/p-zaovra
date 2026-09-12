import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { FilePaths } from "../../src/server/routes/instance/httpapi/groups/file"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"
import { Server } from "../../src/server/server"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, query?: Record<string, string>) {
  const url = new URL(`http://localhost${route}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value)
  }
  return HttpApiApp.webHandler().handler(
    new Request(url, {
      headers: {
        "x-zaovra-directory": directory,
      },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("file HttpApi", () => {
  test("tooling endpoints reject invalid native configuration", async () => {
    for (const invalid of [{ formatter: "invalid" }, { unknown_setting: true }]) {
      await using tmp = await tmpdir({ git: true })
      await Bun.write(
        path.join(tmp.path, "zaovra.json"),
        JSON.stringify({
          providers: { native: { api: { type: "native", settings: {} } } },
          ...invalid,
        }),
      )
      for (const route of ["/lsp", "/formatter"]) {
        expect(
          (await Server.Default().app.request(route, { headers: { "x-zaovra-directory": tmp.path } })).status,
        ).toBe(400)
      }
    }
  })

  test("native tooling configuration loads and refreshes through HTTP", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(
      path.join(tmp.path, "zaovra.json"),
      JSON.stringify({
        providers: { native: { api: { type: "native", settings: {} } } },
        lsp: false,
        formatter: { custom: { command: ["node", "--version"], extensions: [".audit"] } },
      }),
    )
    const app = Server.Default().app
    const headers = { "x-zaovra-directory": tmp.path }
    const lsp = await app.request("/lsp", { headers })
    expect(lsp.status, await lsp.clone().text()).toBe(200)
    expect(await lsp.json()).toEqual([])
    const formatter = await app.request("/formatter", { headers })
    expect(formatter.status).toBe(200)
    expect(await formatter.json()).toContainEqual({ name: "custom", extensions: [".audit"], enabled: true })
    const update = await app.request("/config", {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ formatter: false }),
    })
    expect(update.status).toBe(200)
    const refreshed = await app.request("/formatter", { headers })
    expect(refreshed.status).toBe(200)
    expect(await refreshed.json()).toEqual([])
  })

  test("preserves all whitespace in text file content", async () => {
    await using tmp = await tmpdir({ git: true })
    const text = "\n  indented\r\n\tsecond line  \n\n"
    await Bun.write(path.join(tmp.path, "whitespace.txt"), text)
    const response = await request(FilePaths.content, tmp.path, { path: "whitespace.txt" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ type: "text", content: text })
  })

  test("reads and searches files with native configuration without legacy bootstrap", async () => {
    await using tmp = await tmpdir({ git: true })
    const config = JSON.stringify({
      providers: { native: { api: { type: "native", settings: {} } } },
      permissions: [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "edit", resource: "src/*", effect: "allow" },
      ],
      mcp: { servers: {} },
      skills: [],
    })
    await Bun.write(path.join(tmp.path, "zaovra.json"), config)
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle\n")
    const app = Server.Default().app
    const headers = { "x-zaovra-directory": tmp.path }
    const location = await app.request("/path", { headers })
    expect(location.status).toBe(200)
    expect(await location.json()).toMatchObject({ directory: tmp.path, worktree: tmp.path })
    const status = await app.request("/vcs/status", { headers })
    expect(status.status).toBe(200)
    expect(await status.json()).toContainEqual(
      expect.objectContaining({ file: "hello.txt", additions: 1, deletions: 0, status: "added" }),
    )
    const diff = await app.request("/vcs/diff?mode=git", { headers })
    expect(diff.status).toBe(200)
    expect(await diff.json()).toContainEqual(
      expect.objectContaining({
        file: "hello.txt",
        patch: expect.stringContaining("+needle\n"),
        additions: 1,
        deletions: 0,
      }),
    )
    const raw = await app.request("/vcs/diff/raw", { headers })
    expect(raw.status).toBe(200)
    expect(await raw.text()).toContain("+needle")
    const list = await app.request("/file?path=.", { headers })
    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(expect.objectContaining({ path: "hello.txt", type: "file" }))
    const content = await app.request("/file/content?path=hello.txt", { headers })
    expect(content.status).toBe(200)
    expect(await content.json()).toEqual({ type: "text", content: "needle\n" })
    const text = await app.request("/find?pattern=needle", { headers })
    expect(text.status).toBe(200)
    expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))
    await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await app.request("/find/file?query=hello&type=file", { headers })
          expect(response.status).toBe(200)
          return (await response.json()).includes("hello.txt") ? true : undefined
        }),
        "native file search index was not ready",
      ),
    )
    expect(await Bun.file(path.join(tmp.path, "zaovra.json")).text()).toBe(config)
    const patch =
      "diff --git a/hello.txt b/hello.txt\n--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-needle\n+applied\n"
    const applied = await app.request("/vcs/apply", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ patch }),
    })
    expect(applied.status).toBe(200)
    expect(await applied.json()).toEqual({ applied: true })
    expect(await Bun.file(path.join(tmp.path, "hello.txt")).text()).toBe("applied\n")
    const repeated = await app.request("/vcs/apply", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ patch }),
    })
    expect(repeated.status).toBe(400)
    expect(await repeated.json()).toMatchObject({ name: "VcsApplyError", data: { reason: "not-clean" } })
    expect(await Bun.file(path.join(tmp.path, "hello.txt")).text()).toBe("applied\n")
    const disposed = await app.request("/instance/dispose", { method: "POST", headers })
    expect(disposed.status).toBe(200)
    expect(await disposed.json()).toBe(true)
  })

  test("serves read endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "hello")

    const [list, content, status] = await Promise.all([
      request(FilePaths.list, tmp.path, { path: "." }),
      request(FilePaths.content, tmp.path, { path: "hello.txt" }),
      request(FilePaths.status, tmp.path),
    ])

    expect(list.status).toBe(200)
    expect(await list.json()).toContainEqual(
      expect.objectContaining({ name: "hello.txt", path: "hello.txt", type: "file" }),
    )

    expect(content.status).toBe(200)
    expect(await content.json()).toMatchObject({ type: "text", content: "hello" })

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual([])
  })

  test("serves search endpoints", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "hello.txt"), "needle")

    const [text, symbols] = await Promise.all([
      request(FilePaths.findText, tmp.path, { pattern: "needle" }),
      request(FilePaths.findSymbol, tmp.path, { query: "hello" }),
    ])
    const files = await Effect.runPromise(
      pollWithTimeout(
        Effect.promise(async () => {
          const response = await request(FilePaths.findFile, tmp.path, { query: "hello", type: "file" })
          const body = await response.json()
          return body.includes("hello.txt") ? { response, body } : undefined
        }),
        "file search index was not ready",
      ),
    )

    expect(text.status).toBe(200)
    expect(await text.json()).toContainEqual(expect.objectContaining({ line_number: 1 }))

    expect(files.response.status).toBe(200)
    expect(files.body).toContain("hello.txt")

    expect(symbols.status).toBe(200)
    expect(await symbols.json()).toEqual([])
  })
})
