import { afterEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Npm } from "@zaovra-ai/core/npm"
import { Ripgrep } from "@zaovra-ai/core/ripgrep"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Workspace } from "../../src/control-plane/workspace"
import { Plugin } from "../../src/plugin/index"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceState } from "../../src/effect/instance-state"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionV2 } from "@zaovra-ai/core/session"
import { WorkspaceV2 } from "@zaovra-ai/core/workspace"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { registerAdapter } from "../../src/control-plane/adapters"

const noopBootstrapLayer = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Plugin.node, Workspace.node, InstanceStore.node, Ripgrep.node, SessionV2.node]),
    [
      [Account.node, AccountTest.empty],
      [SessionExecution.node, SessionExecution.noopLayer],
      [Npm.node, NpmTest.noop],
      [InstanceStore.bootstrapNode, noopBootstrapLayer],
      [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true, experimentalWorkspaces: true })],
    ],
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("plugin.workspace", () => {
  ;(it.instance("retains failed environments for cleanup and never reprovisions an existing ID", () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace.Service
      const sessions = yield* SessionV2.Service
      const ctx = yield* InstanceState.context
      const id = WorkspaceV2.ID.ascending()
      const type = `failure-${id}`
      let attempts = 0
      let removeFails = true
      registerAdapter(ctx.project.id, type, {
        name: "failure",
        description: "Recovery regression adapter",
        configure: async (input) => ({ ...input, directory: path.join(ctx.directory, "partial") }),
        create: async () => {
          attempts++
          throw new Error("provisioning failed after allocation")
        },
        remove: async () => {
          if (removeFails) throw new Error("cleanup unavailable")
        },
        target: (input) => ({ type: "local", directory: input.directory! }),
      })
      const input = { id, type, projectID: ctx.project.id, branch: null }
      expect(Exit.isFailure(yield* workspace.create(input).pipe(Effect.exit))).toBe(true)
      expect(yield* workspace.get(id)).toBeDefined()
      expect(yield* workspace.status()).toContainEqual({ workspaceID: id, status: "error" })
      yield* workspace.create(input)
      expect(attempts).toBe(1)
      const session = yield* sessions.create({
        location: { directory: AbsolutePath.make(ctx.directory), workspaceID: id },
      })
      expect(Exit.isFailure(yield* workspace.remove(id).pipe(Effect.exit))).toBe(true)
      expect(yield* workspace.get(id)).toBeDefined()
      expect((yield* sessions.get(session.id)).id).toBe(session.id)
      removeFails = false
      yield* workspace.remove(id)
      expect(yield* workspace.get(id)).toBeUndefined()
    }),
  ),
    it.instance("plugin can install a workspace adapter", () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const type = `plug-${Math.random().toString(36).slice(2)}`
        const file = path.join(dir, "plugin.ts")
        const mark = path.join(dir, "created.json")
        const space = path.join(dir, "space")
        yield* Effect.promise(() =>
          Bun.write(
            file,
            [
              "export default async ({ experimental_workspace }) => {",
              `  experimental_workspace.register(${JSON.stringify(type)}, {`,
              '    name: "plug",',
              '    description: "plugin workspace adapter",',
              "    configure(input) {",
              `      return { ...input, name: "plug", branch: "plug/main", directory: ${JSON.stringify(space)} }`,
              "    },",
              "    async create(input) {",
              `      await Bun.write(${JSON.stringify(mark)}, JSON.stringify(input))`,
              "    },",
              "    async remove() {},",
              "    target(input) {",
              '      return { type: "local", directory: input.directory }',
              "    },",
              "  })",
              "  return {}",
              "}",
              "",
            ].join("\n"),
          ),
        )

        yield* Effect.promise(() =>
          Bun.write(
            path.join(dir, "zaovra.json"),
            JSON.stringify(
              {
                $schema: "https://zaovra.com/config.json",
                plugin: [pathToFileURL(file).href],
              },
              null,
              2,
            ),
          ),
        )

        const plugin = yield* Plugin.Service
        yield* plugin.init()
        const workspace = yield* Workspace.Service
        const ctx = yield* InstanceState.context
        const info = yield* workspace.create({
          type,
          branch: null,
          extra: { key: "value" },
          projectID: ctx.project.id,
        })

        expect(info.type).toBe(type)
        expect(info.name).toBe("plug")
        expect(info.branch).toBe("plug/main")
        expect(info.directory).toBe(space)
        expect(info.extra).toEqual({ key: "value" })
        expect(JSON.parse(yield* Effect.promise(() => Bun.file(mark).text()))).toMatchObject({
          type,
          name: "plug",
          branch: "plug/main",
          directory: space,
          extra: { key: "value" },
        })
      }),
    ))
})
