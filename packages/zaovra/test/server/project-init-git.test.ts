import { afterEach, describe, expect } from "bun:test"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import path from "path"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
import { UI_UPSTREAM } from "../../src/server/shared/ui"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const testInstanceStore = AppNodeBuilder.build(InstanceStore.node, [[InstanceStore.bootstrapNode, noopBootstrap]])
const it = testEffect(Layer.mergeAll(AppNodeBuilder.build(FSUtil.node), testInstanceStore, httpApiLayer))

describe("789 removed project initialization endpoint", () => {
  for (const git of [false, true])
    it.instance(
      `does not create or change a repository (git=${git})`,
      () =>
        Effect.gen(function* () {
          const tmp = yield* TestInstance
          const fs = yield* FSUtil.Service
          const forwarded: string[] = []
          // The real router sends unmatched paths to the UI. Keep that request
          // on loopback and restore the shared URL when this test scope closes.
          const upstream = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = UI_UPSTREAM.href
              const server = Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch(request) {
                  forwarded.push(request.url)
                  return new Response("Not Found", { status: 404 })
                },
              })
              UI_UPSTREAM.href = `http://127.0.0.1:${server.port}/`
              return { server, previous }
            }),
            (value) =>
              Effect.sync(() => {
                UI_UPSTREAM.href = value.previous
                value.server.stop(true)
              }),
          )
          expect(OpenApi.fromApi(PublicApi).paths?.["/project/git/init"]).toBeUndefined()
          const before = yield* requestInDirectory("/project/current", tmp.directory)
          expect(before.status).toBe(200)
          const project = yield* before.json
          const exists = yield* fs.exists(path.join(tmp.directory, ".git"))
          const response = yield* requestInDirectory("/project/git/init", tmp.directory, { method: "POST" })
          if (response.status !== 404) {
            const body = yield* response.text
            yield* Effect.sync(() =>
              console.error("removed endpoint response", { status: response.status, body, forwarded }),
            )
          }
          expect(response.status).toBe(404)
          expect(forwarded).toEqual([`http://127.0.0.1:${upstream.server.port}/project/git/init`])
          expect(yield* fs.exists(path.join(tmp.directory, ".git"))).toBe(exists)
          const after = yield* requestInDirectory("/project/current", tmp.directory)
          expect(yield* after.json).toEqual(project)
        }),
      { git },
    )
})
