import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer, ManagedRuntime, Option, Scope } from "effect"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { MemoryGroup } from "@zaovra-ai/protocol/groups/memory"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Catalog } from "@zaovra-ai/core/catalog"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { MemoryTidy } from "@zaovra-ai/core/memory/tidy"
import { MemoryTidyStore } from "@zaovra-ai/core/memory/tidy-store"
import { MemoryTidyTasks } from "@zaovra-ai/core/memory/tidy-tasks"
import { MemoryStore } from "@zaovra-ai/core/memory/store"
import { MemoryPages } from "@zaovra-ai/core/memory/pages"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionRunCoordinator } from "@zaovra-ai/core/session/run-coordinator"
import { Config } from "@zaovra-ai/core/config"
import { Database } from "@zaovra-ai/core/database/database"
import { Global } from "@zaovra-ai/core/global"
import { Location } from "@zaovra-ai/core/location"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { Project } from "@zaovra-ai/core/project"
import { MemoryHandler } from "./handlers/memory"
import { LocationMiddleware, type LocationServices } from "./location"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { ServerAuth } from "./auth"
import { tmpdir } from "../../core/test/fixture/tmpdir"

test("memory task HTTP and generated client preserve confirmation, stop and scope boundaries", async () => {
  await using tmp = await tmpdir()
  const state: { enabled?: boolean; starts: number; stops: number } = { enabled: true, starts: 0, stops: 0 }
  const started = Promise.withResolvers<void>()
  const runtime = ManagedRuntime.make(
    AppNodeBuilder.build(
      LayerNode.group([
        Catalog.node,
        MemoryTidy.node,
        MemoryTidyTasks.node,
        Config.node,
        MemoryTidyStore.node,
        MemoryStore.node,
        MemoryPages.node,
        SessionV2.node,
        Location.node,
        Database.node,
      ]),
      [
        [
          Location.node,
          Layer.succeed(Location.Service, {
            directory: AbsolutePath.make(tmp.path),
            project: { id: Project.ID.global, directory: AbsolutePath.make(tmp.path) },
          }),
        ],
        [
          Global.node,
          Global.layerWith({
            data: path.join(tmp.path, "data"),
            config: path.join(tmp.path, "config"),
            state: path.join(tmp.path, "state"),
          }),
        ],
        [
          Config.node,
          Layer.succeed(Config.Service, {
            entries: () =>
              Effect.sync(() => [
                new Config.Document({
                  type: "document",
                  info: new Config.Info({ memory: { enabled: state.enabled } }),
                }),
              ]),
          }),
        ],
        [
          SessionExecution.node,
          Layer.effect(
            SessionExecution.Service,
            Effect.gen(function* () {
              const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, never>({
                drain: (_id, _force, claim) =>
                  Effect.gen(function* () {
                    yield* claim?.check ?? Effect.void
                    state.starts++
                    started.resolve()
                    yield* Effect.never
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        state.stops++
                      }),
                    ),
                  ),
              })
              return SessionExecution.Service.of({
                active: coordinator.active,
                resume: (id, claim) => (claim ? coordinator.owned(id, claim) : coordinator.run(id)),
                wake: () => Effect.void,
                interrupt: coordinator.interrupt,
                prepareInterrupt: coordinator.prepareInterrupt,
              })
            }),
          ),
        ],
      ],
    ),
  )
  const registered = await runtime.runPromise(
    Catalog.Service.use((catalog) =>
      catalog.transform((draft) => {
        const provider = ProviderV2.ID.make("fixture")
        draft.provider.update(provider, () => {})
        draft.model.update(provider, ModelV2.ID.make("fixture"), (model) => {
          model.api = {
            id: model.id,
            type: "aisdk",
            package: "@ai-sdk/openai",
            url: "http://localhost/v1",
            settings: {},
          }
        })
      }),
    ).pipe(Effect.provideService(Scope.Scope, runtime.scope)),
  )
  const context = await runtime.runPromise(
    Effect.context<
      | Catalog.Service
      | MemoryTidy.Service
      | MemoryTidyStore.Service
      | MemoryTidyTasks.Service
      | Config.Service
      | MemoryStore.Service
      | MemoryPages.Service
      | Database.Service
      | SessionV2.Service
      | Location.Service
    >(),
  )
  const placement = Layer.succeedContext(context) as Layer.Layer<LocationServices>
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
      Layer.provide(Layer.succeedContext(context)),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  )
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => web.handler(request, context) })
  const client = createZaovraClient({ baseUrl: server.url.href, throwOnError: true })
  try {
    const request = {
      requestID: "http-confirmed",
      model: { id: "fixture", providerID: "fixture" },
      tokens: 1000,
      dailyTokens: 2000,
    }
    const invalid = await fetch(new URL("/api/memory/tidy", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, tokens: 0 }),
    })
    expect(invalid.status).toBeGreaterThanOrEqual(400)
    expect((await client.v2.memory.listTidy({}, { throwOnError: true })).data.data).toHaveLength(0)
    const prepared = (await client.v2.memory.prepareTidy({ memoryTidyRequest: request }, { throwOnError: true })).data
      .data
    await runtime.runPromise(registered.dispose)
    expect(prepared.executing).toBe(false)
    expect(prepared.tokens).toBe(1000)
    expect(state.starts).toBe(0)
    expect(
      (await client.v2.memory.prepareTidy({ memoryTidyRequest: request }, { throwOnError: true })).data.data.id,
    ).toBe(prepared.id)
    const conflict = await fetch(new URL("/api/memory/tidy", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, tokens: 2000 }),
    })
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).reason).toBe("conflict")
    expect((await client.v2.memory.listTidy({}, { throwOnError: true })).data.data.map((run) => run.id)).toEqual([
      prepared.id,
    ])
    const page = await runtime.runPromise(
      Effect.gen(function* () {
        const pages = yield* MemoryPages.Service
        const memory = yield* MemoryStore.Service
        const tidy = yield* MemoryTidyStore.Service
        const run = yield* tidy.get(prepared.id)
        if (!run) throw new Error("confirmed task missing")
        const note = yield* memory.write({
          scope: run.scope,
          origin: "user",
          status: "verified",
          kind: "practice",
          text: "HTTP page source",
        })
        if (!note) throw new Error("source missing")
        return yield* pages.publish(
          { sessionID: run.session_id, scope: run.scope, enabled: true },
          {
            title: "HTTP guide",
            summary: "A tested guide",
            body: "Initial guide body",
            sources: [MemoryPages.source(note)],
          },
        )
      }),
    )
    const view = { ...page, sources: [...page.sources] }
    expect((await client.v2.memory.listPages({}, { throwOnError: true })).data.data).toEqual([view])
    expect((await client.v2.memory.getPage({ id: page.id }, { throwOnError: true })).data.data).toEqual(view)
    expect(
      (await client.v2.memory.getPage({ id: page.id, layer: "user" }, { throwOnError: true })).data.data,
    ).toBeNull()
    const edited = (
      await client.v2.memory.updatePage(
        { id: page.id, summary: "My guide", body: "Corrected guide", expected: page.revision },
        { throwOnError: true },
      )
    ).data.data
    expect(edited.origin).toBe("user")
    const staleEdit = await fetch(new URL(`/api/memory/pages/${page.id}`, server.url), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: "stale", body: "stale overwrite", expected: page.revision }),
    })
    expect(staleEdit.status).toBe(409)
    expect((await staleEdit.json()).reason).toBe("conflict")
    await client.v2.memory.removePage({ id: page.id, layer: "user" }, { throwOnError: true })
    expect((await client.v2.memory.getPage({ id: page.id }, { throwOnError: true })).data.data).toEqual(edited)
    await client.v2.memory.clear({}, { throwOnError: true })
    expect((await client.v2.memory.listPages({}, { throwOnError: true })).data.data).toEqual([])
    expect((await client.v2.memory.list({}, { throwOnError: true })).data.data).toEqual([])
    for (const enabled of [undefined, false]) {
      state.enabled = enabled
      const disabled = await fetch(new URL(`/api/memory/tidy/${prepared.id}/start`, server.url), { method: "POST" })
      expect(disabled.status).toBe(409)
      expect((await disabled.json()).reason).toBe("unauthorized")
      expect(state.starts).toBe(0)
    }
    state.enabled = true
    await client.v2.memory.startTidy({ id: prepared.id }, { throwOnError: true })
    await started.promise
    await client.v2.memory.startTidy({ id: prepared.id }, { throwOnError: true })
    expect(state.starts).toBe(1)
    const h = await runtime.runPromise(
      Effect.gen(function* () {
        return { store: yield* MemoryTidyStore.Service, sessions: yield* SessionV2.Service }
      }),
    )
    const run = await runtime.runPromise(h.store.get(prepared.id))
    await runtime.runPromise(
      h.store.reserve({
        sessionID: run!.session_id,
        scope: run!.scope,
        enabled: true,
        attemptID: "http-unknown",
        tokens: 100,
      }),
    )
    const wrongLayer = await fetch(new URL(`/api/memory/tidy/${prepared.id}/cancel?layer=user`, server.url), {
      method: "POST",
    })
    expect(wrongLayer.status).toBe(409)
    expect((await wrongLayer.json()).reason).toBe("missing")
    state.enabled = false
    const cancelled = (await client.v2.memory.cancelTidy({ id: prepared.id }, { throwOnError: true })).data.data
    expect(cancelled.state).toBe("cancelled")
    expect(cancelled.usage).toEqual({ known: 0, reserved: 100, charged: 100, unknown: 1 })
    expect(state.stops).toBe(1)
    expect(await runtime.runPromise(h.sessions.pendingInputs(run!.session_id))).toHaveLength(0)
    await client.v2.memory.startTidy({ id: prepared.id }, { throwOnError: true })
    expect((await client.v2.memory.getTidy({ id: prepared.id }, { throwOnError: true })).data.data.state).toBe(
      "cancelled",
    )
    expect(state.starts).toBe(1)
  } finally {
    server.stop(true)
    await web.dispose()
    await runtime.dispose()
  }
})
