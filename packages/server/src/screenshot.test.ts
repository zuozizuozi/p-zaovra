import { expect, test } from "bun:test"
import { Effect, Layer, LayerMap, ManagedRuntime, Option } from "effect"
import { Location } from "@zaovra-ai/core/location"
import { Database } from "@zaovra-ai/core/database/database"
import { Project } from "@zaovra-ai/core/project"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { SessionTable } from "@zaovra-ai/core/session/sql"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { LocationServiceMap } from "@zaovra-ai/core/location-service-map"
import type { LocationServices } from "./location"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { ServerAuth } from "./auth"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/unstable/http"
import { makeSessionGroup } from "@zaovra-ai/protocol/groups/session"
import { Global } from "@zaovra-ai/core/global"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionHandler } from "./handlers/session"
import { SessionLocationMiddleware, sessionLocationLayer } from "./middleware/session-location"
import fs from "node:fs/promises"
import path from "node:path"

test("actual screenshot HTTP handler returns PNG JSON and rejects foreign references", async () => {
  const root = process.env.ZAOVRA_SCREENSHOT_TEST_ROOT
  if (!root) throw new Error("Set isolated screenshot storage")
  const directory = path.join(root, "tool-output")
  await fs.mkdir(directory, { recursive: true })
  const id = `tool_${Buffer.from("ses_http").toString("hex")}_http.png`
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY2BgYPgPAAEEAQBwIGULAAAAAElFTkSuQmCC", "base64")
  await fs.writeFile(path.join(directory, id), png)
  const artifacts: { reference: string; data: string }[] = process.env.ZAOVRA_SCREENSHOT_MANIFEST
    ? await Bun.file(process.env.ZAOVRA_SCREENSHOT_MANIFEST).json() : []
  for (const item of artifacts) {
    if (!/^tool_7365735f62726f777365725f61_[a-zA-Z0-9_-]+\.png$/.test(item.reference)) throw Error("Invalid fixture reference")
    await fs.writeFile(path.join(directory, item.reference), Buffer.from(item.data, "base64"))
  }
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Global.layerWith({ data: root }),
    Database.layerFromPath(":memory:"),
  ))
  const context = await runtime.runPromise(Effect.context<Global.Service | Database.Service>())
  await runtime.runPromise(Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db.insert(ProjectTable).values({
      id: Project.ID.global, worktree: AbsolutePath.make(root), sandboxes: [],
    }).run()
    yield* database.db.insert(SessionTable).values(["ses_http", "ses_other", "ses_browser_a"].map((id) => ({
      id: SessionV2.ID.make(id), project_id: Project.ID.global,
      slug: id, directory: root, title: id, version: "test",
    }))).run()
  }))
  const placements: string[] = []
  const database = await runtime.runPromise(Database.Service)
  // Real database lookup and middleware; unrelated Location services remain inert.
  const routes = (data: string, store: typeof database) => HttpApiBuilder.layer(HttpApi.make("server").add(makeSessionGroup(SessionLocationMiddleware))).pipe(
    Layer.provide(SessionHandler),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(ServerAuth.Config.configLayer({ username: "zaovra", password: Option.none() })),
    Layer.provide(Layer.mock(SessionV2.Service, { revert: {
      stage: () => Effect.die("Unexpected revert"),
      clear: () => Effect.die("Unexpected revert"),
      commit: () => Effect.die("Unexpected revert"),
    } })),
    Layer.provide(Global.layerWith({ data })),
    Layer.provide(sessionLocationLayer.pipe(
      Layer.provide(Layer.effect(LocationServiceMap.Service, LayerMap.make((ref: Location.Ref) => {
          placements.push(ref.directory)
          return Layer.empty as Layer.Layer<LocationServices>
      }))),
      Layer.provide(Layer.succeed(Database.Service, store)),
    )),
    Layer.provide(HttpServer.layerServices),
    Layer.merge(HttpRouter.middleware(HttpMiddleware.cors({ allowedOrigins: () => true }), { global: true })),
  )
  const server = HttpRouter.toWebHandler(routes(root, database), { disableLogger: true })
  try {
    // Production requests carry middleware context; dependencies must be captured
    // by the handler layer rather than supplied again by each request.
    const response = await server.handler(new Request(`http://offline/api/session/ses_http/screenshot/${id}`))
    expect(response.status).toBe(200)
    const image = await response.json()
    expect(image).toEqual({ data: png.toString("base64"), mime: "image/png" })
    const { make } = await import("@zaovra-ai/core/image/photon")
    const normalize = await Effect.runPromise(make)
    expect(await Effect.runPromise(normalize("http-fixture", {
      uri: "http-fixture", content: image.data, encoding: "base64", mime: image.mime,
    }, { autoResize: false, maxWidth: 1, maxHeight: 1, maxBase64Bytes: 1024 }))).toMatchObject({
      content: image.data, mime: "image/png",
    })
    expect(placements).toEqual([path.resolve(root)])
    const unknown = await server.handler(new Request(`http://offline/api/session/ses_absent/screenshot/${id}`), context)
    expect(unknown.status).toBe(404)
    expect(placements).toHaveLength(1)
    const otherRuntime = ManagedRuntime.make(Layer.mergeAll(
      Global.layerWith({ data: path.join(root, "other-server") }),
      Database.layerFromPath(":memory:"),
    ))
    const otherDatabase = await otherRuntime.runPromise(Database.Service)
    await otherRuntime.runPromise(Effect.gen(function* () {
      yield* otherDatabase.db.insert(ProjectTable).values({
        id: Project.ID.global, worktree: AbsolutePath.make(root), sandboxes: [],
      }).run()
      yield* otherDatabase.db.insert(SessionTable).values({
        id: SessionV2.ID.make("ses_http"), project_id: Project.ID.global,
        slug: "ses_http", directory: root, title: "independent server", version: "test",
      }).run()
    }))
    const otherServer = HttpRouter.toWebHandler(routes(path.join(root, "other-server"), otherDatabase), { disableLogger: true })
    try {
      const otherContext = await otherRuntime.runPromise(Effect.context<Global.Service>())
      const isolated = await otherServer.handler(
        new Request(`http://offline/api/session/ses_http/screenshot/${id}`),
        otherContext,
      )
      expect(isolated.status).toBe(400)
      const absentOnOther = await otherServer.handler(
        new Request(`http://offline/api/session/ses_other/screenshot/${id}`), otherContext,
      )
      expect(absentOnOther.status).toBe(404)
      expect(await isolated.text()).not.toContain(root)
      const original = await server.handler(
        new Request(`http://offline/api/session/ses_http/screenshot/${id}`), context,
      )
      expect(original.status).toBe(200)
      const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => server.handler(request, context) })
      const second = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => otherServer.handler(request, otherContext) })
      try {
        const pathname = `/api/session/ses_http/screenshot/${id}`
        const firstResponse = await fetch(new URL(pathname, first.url))
        expect(firstResponse.status).toBe(200)
        expect(await firstResponse.json()).toEqual({ data: png.toString("base64"), mime: "image/png" })
        const secondResponse = await fetch(new URL(pathname, second.url))
        expect(secondResponse.status).toBe(400)
        expect(await secondResponse.text()).not.toContain(root)
        const secondMissing = await fetch(new URL(`/api/session/ses_other/screenshot/${id}`, second.url))
        expect(secondMissing.status).toBe(404)
        await secondMissing.arrayBuffer()
        for (const item of [{ reference: id, sessionID: "ses_http" }, ...artifacts.map((item) => ({ ...item, sessionID: "ses_browser_a" }))]) {
        const child = Bun.spawn([
          process.execPath, "test", "--conditions=browser", "--preload", "./happydom.ts",
          "--preload", "./test-browser/fixtures/solid-preload.ts",
          "./test-browser/fixtures/browser-screenshot.fixture.ts",
        ], {
          cwd: path.resolve(import.meta.dir, "../../app-ui"),
          env: { ...process.env, ZAOVRA_SCREENSHOT_NETWORK_A: first.url.href,
            ZAOVRA_SCREENSHOT_NETWORK_B: second.url.href, ZAOVRA_SCREENSHOT_NETWORK_ID: item.reference, ZAOVRA_SCREENSHOT_NETWORK_SESSION: item.sessionID },
          stdout: "pipe", stderr: "pipe",
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ])
        expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" })
        }
      } finally {
        await first.stop(true)
        await second.stop(true)
      }
    } finally {
      await otherServer.dispose()
      await otherRuntime.dispose()
    }
    const denied = await server.handler(new Request(`http://offline/api/session/ses_other/screenshot/${id}`), context)
    expect(denied.status).toBe(400)
    expect(await denied.text()).not.toContain(root)
    const missing = await server.handler(
      new Request("http://offline/api/session/ses_http/screenshot/tool_7365735f68747470_missing.png"),
      context,
    )
    expect(missing.status).toBe(400)
    expect(await missing.text()).not.toContain(root)
    await fs.writeFile(path.join(directory, id), "not a PNG")
    const invalid = await server.handler(new Request(`http://offline/api/session/ses_http/screenshot/${id}`), context)
    expect(invalid.status).toBe(400)
    await fs.writeFile(path.join(directory, id), png)
    const expiredAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await fs.utimes(path.join(directory, id), expiredAt, expiredAt)
    const expired = await server.handler(new Request(`http://offline/api/session/ses_http/screenshot/${id}`), context)
    expect(expired.status).toBe(400)
    expect(await expired.text()).not.toContain(root)
  } finally {
    await server.dispose()
    await runtime.dispose()
    await fs.unlink(path.join(directory, id))
    await Promise.all(artifacts.map((item) => fs.unlink(path.join(directory, item.reference))))
  }
}, 30_000)
