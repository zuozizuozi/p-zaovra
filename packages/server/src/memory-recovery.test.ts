import { expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { MemoryGroup } from "@zaovra-ai/protocol/groups/memory"
import { Memory } from "@zaovra-ai/schema/memory"
import { Database } from "@zaovra-ai/core/database/database"
import { MemoryStore } from "@zaovra-ai/core/memory/store"
import { MemoryNoteTable } from "@zaovra-ai/core/memory/sql"
import { Project } from "@zaovra-ai/core/project"
import { Location } from "@zaovra-ai/core/location"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { Hash } from "@zaovra-ai/core/util/hash"
import { LocationMiddleware, type LocationServices } from "./location"
import { MemoryHandler } from "./handlers/memory"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { ServerAuth } from "./auth"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"

test("actual memory HTTP and generated SDK recover explicitly and preserve deletion suppression", async () => {
  const place = { project: Project.ID.global, directory: "/http/Alpha" }
  const runtime = ManagedRuntime.make(
    MemoryStore.layerWith("linux").pipe(Layer.provideMerge(Database.layerFromPath(":memory:"))),
  )
  const context = await runtime.runPromise(Effect.context<MemoryStore.Service | Database.Service>())
  await runtime.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .insert(MemoryNoteTable)
        .values([
          {
            id: Memory.ID.make("mem_http_old"),
            scope: MemoryStore.scope(place, "win32"),
            key: "old",
            kind: "practice",
            text: "HTTP old note",
            origin: "model",
            status: "unverified",
            time_observed: 1,
          },
          {
            id: Memory.ID.make("mem_http_deleted"),
            scope: MemoryStore.scope(place, "win32"),
            key: `deleted-text:${Hash.fast("deleted http")}`,
            kind: "practice",
            text: "",
            origin: "model",
            status: "unverified",
            time_observed: 1,
            time_deleted: 1,
          },
        ])
        .run()
    }),
  )
  // Only the two Location services used by these handlers are needed in this fixed-placement fixture.
  const placement = Layer.merge(
    Layer.succeedContext(context),
    Layer.succeed(Location.Service, {
      directory: AbsolutePath.make(place.directory),
      project: { id: place.project, directory: AbsolutePath.make(place.directory) },
    }),
  ) as Layer.Layer<LocationServices>
  // Fixed test Location; production handlers, codecs, generated client and DB are real.
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(HttpApi.make("server").add(MemoryGroup)).pipe(
      Layer.provide(MemoryHandler),
      Layer.provide(
        Layer.succeed(
          LocationMiddleware,
          LocationMiddleware.of((effect) => effect.pipe(Effect.provide(placement))),
        ),
      ),
      Layer.provide(authorizationLayer),
      Layer.provide(schemaErrorLayer),
      Layer.provide(ServerAuth.Config.configLayer({ username: "zaovra", password: Option.none() })),
      Layer.provide(
        Layer.succeed(Location.Service, {
          directory: AbsolutePath.make(place.directory),
          project: { id: place.project, directory: AbsolutePath.make(place.directory) },
        }),
      ),
      Layer.provide(Layer.succeedContext(context)),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  )
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => web.handler(request, context) })
  const client = createZaovraClient({ baseUrl: server.url.href, throwOnError: true })
  try {
    const pending = (await client.v2.memory.recovery({}, { throwOnError: true })).data.data
    expect(pending.frozen).toBe(true)
    expect(pending.automaticFrozen).toBe(false)
    expect(pending.notes[0].note.id).toBe("mem_http_old")
    expect(pending.deleted).toBe(1)
    expect(
      (await client.v2.memory.create({ kind: "practice", text: "before confirmation" }, { throwOnError: true })).data
        .data,
    ).toBeNull()
    expect(
      (await client.v2.memory.update({ id: "mem_http_old", text: "tamper" }, { throwOnError: true })).data.data,
    ).toBeNull()
    await client.v2.memory.remove({ id: "mem_http_old" }, { throwOnError: true })
    expect((await client.v2.memory.recovery({}, { throwOnError: true })).data.data.notes[0].note.text).toBe(
      "HTTP old note",
    )
    const response = await client.v2.memory.resolveRecovery(
      { memoryRecoveryChoice: { decision: "restore", ids: ["mem_http_old"] } },
      { throwOnError: true },
    )
    expect(response.data.accepted).toBe(true)
    expect(response.data.data.frozen).toBe(false)
    await client.v2.memory.resolveRecovery(
      { memoryRecoveryChoice: { decision: "restore", ids: ["mem_http_old"] } },
      { throwOnError: true },
    )
    expect((await client.v2.memory.list({}, { throwOnError: true })).data.data).toHaveLength(1)
    expect(
      (await client.v2.memory.create({ kind: "practice", text: "deleted http" }, { throwOnError: true })).data.data,
    ).toBeNull()
    expect(
      (await client.v2.memory.create({ kind: "practice", text: "new HTTP note" }, { throwOnError: true })).data.data
        ?.origin,
    ).toBe("user")
    const invalid = await fetch(new URL("/api/memory/recovery", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "automatic", ids: [] }),
    })
    expect(invalid.status).toBeGreaterThanOrEqual(400)
  } finally {
    server.stop(true)
    await web.dispose()
    await runtime.dispose()
  }
})
