import { expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@zaovra-ai/core/cross-spawn-spawner"
import { InstanceRef } from "@/effect/instance-ref"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Project } from "@/project/project"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Format.node, LSP.node, Project.node, CrossSpawnSpawner.node])))

it.live("native configuration starts an LSP and executes a formatter", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    yield* Effect.promise(() =>
      Bun.write(
        path.join(directory, "zaovra.json"),
        JSON.stringify({
          providers: { native: { api: { type: "native", settings: {} } } },
          permissions: [{ action: "edit", resource: "*", effect: "deny" }],
          lsp: {
            fake: {
              command: [process.execPath, path.resolve(__dirname, "../fixture/lsp/fake-lsp-server.js")],
              extensions: [".repro"],
            },
          },
          formatter: {
            custom: {
              command: ["node", "-e", "require('fs').appendFileSync(process.argv[1], 'formatted')", "$FILE"],
              extensions: [".repro"],
            },
          },
        }),
      ),
    )
    const project = yield* Project.Service
    const placement = yield* project.fromDirectory(directory)
    yield* Effect.gen(function* () {
      const file = path.join(directory, "sample.repro")
      yield* Effect.promise(() => Bun.write(file, "before\n"))
      const lsp = yield* LSP.Service
      yield* lsp.touchFile(file)
      expect(yield* lsp.status()).toContainEqual(expect.objectContaining({ name: "fake", status: "connected" }))
      const format = yield* Format.Service
      expect(yield* format.file(file)).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("before\nformatted")
    }).pipe(Effect.provideService(InstanceRef, { directory, worktree: placement.sandbox, project: placement.project }))
  }),
)
