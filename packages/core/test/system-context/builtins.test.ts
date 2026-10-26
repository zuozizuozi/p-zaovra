import { ShellIdentity } from "@zaovra-ai/core/shell-identity"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Config } from "@zaovra-ai/core/config"
import { Location } from "@zaovra-ai/core/location"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { Global } from "@zaovra-ai/core/global"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SystemContext } from "@zaovra-ai/core/system-context"
import { SystemContextBuiltIns } from "@zaovra-ai/core/system-context/builtins"
import { SystemContextRegistry } from "@zaovra-ai/core/system-context/registry"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const directory = AbsolutePath.make(FSUtil.resolve("/repo/packages/core"))
const projectDirectory = AbsolutePath.make(FSUtil.resolve("/repo"))
const instructionFile = FSUtil.resolve("/repo/AGENTS.md")
const timestamp = Date.parse("2026-06-03T12:00:00.000Z")
const localDate = (time: number) => new Date(time).toDateString()
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location(
      { directory },
      { projectDirectory, vcs: { type: "git", store: AbsolutePath.make(FSUtil.resolve("/repo/.git")) } },
    ),
  ),
)
const builtInsNode = LayerNode.group([SystemContextBuiltIns.node, SystemContextRegistry.node])
const it = testEffect(
  AppNodeBuilder.build(builtInsNode, [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: "/global" })],
  ]),
)
const itWithoutGit = testEffect(
  AppNodeBuilder.build(builtInsNode, [
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory }, { projectDirectory }))),
    ],
    [Global.node, Global.layerWith({ config: "/global" })],
  ]),
)
const instructionFS = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.pipe(
    Effect.map((fs) =>
      FSUtil.Service.of({
        ...fs,
        up: (options) => Effect.succeed(options.targets.includes("AGENTS.md") ? [instructionFile] : []),
        readFileStringSafe: (path) => Effect.succeed(path === instructionFile ? "Be precise." : undefined),
      }),
    ),
  ),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const itWithInstructions = testEffect(
  AppNodeBuilder.build(builtInsNode, [
    [Location.node, locationLayer],
    [FSUtil.node, instructionFS],
    [Global.node, Global.layerWith({ config: "/global" })],
  ]),
)

describe("SystemContextBuiltIns", () => {
  itWithoutGit.effect("labels a non-git project root without implying a repository", () =>
    Effect.gen(function* () {
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      expect(initialized.baseline).toContain(`Working directory: ${directory}`)
      expect(initialized.baseline).toContain(`Project root: ${projectDirectory}`)
      expect(initialized.baseline).toContain("Is directory a git repo: no")
      expect(initialized.baseline).not.toContain("Repository root:")
    }),
  )

  it.effect("loads location-scoped environment and host-local date context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      expect(initialized.baseline).toContain("Execution shell:")
      expect(initialized.baseline.replace(/\nExecution shell: [^\n]+/, "")).toBe(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Repository root: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          "</env>",
          "",
          `Today's date: ${localDate(timestamp)}`,
        ].join("\n"),
      )
    }),
  )

  it.effect("reconciles the date without repeating unchanged environment context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      yield* TestClock.setTime(timestamp + 24 * 60 * 60 * 1000)
      const refreshed = yield* SystemContext.reconcile(yield* context.load(), initialized.snapshot)

      expect(refreshed).toMatchObject({
        _tag: "Updated",
        text: `Today's date is now: ${localDate(timestamp + 24 * 60 * 60 * 1000)}`,
      })
    }),
  )

  it.effect("does not update again within the same local calendar day", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      yield* TestClock.setTime(timestamp + 60 * 60 * 1000)
      expect(yield* SystemContext.reconcile(yield* context.load(), initialized.snapshot)).toEqual({ _tag: "Unchanged" })
    }),
  )

  itWithInstructions.effect("composes ambient instructions after built-in context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service

      expect(
        (yield* SystemContext.initialize(yield* context.load())).baseline.replace(/\nExecution shell: [^\n]+/, ""),
      ).toBe(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Repository root: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          "</env>",
          "",
          `Today's date: ${localDate(timestamp)}`,
          "",
          `Instructions from: ${instructionFile}\nBe precise.`,
        ].join("\n"),
      )
    }),
  )
})

for (const shell of process.platform === "win32" ? ["powershell", "cmd"] : ["/bin/bash", "/bin/sh"]) {
  const configured = testEffect(
    AppNodeBuilder.build(builtInsNode, [
      [Location.node, locationLayer],
      [
        Config.node,
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([new Config.Document({ type: "document", info: new Config.Info({ shell }) })]),
          }),
        ),
      ],
    ]),
  )
  configured.effect(`R2 environment identifies configured shell ${shell}`, () =>
    Effect.gen(function* () {
      const registry = yield* SystemContextRegistry.Service
      expect((yield* SystemContext.initialize(yield* registry.load())).baseline).toContain(
        ShellIdentity.guidance(ShellIdentity.resolve(shell, "project", false)),
      )
    }),
  )
}
