import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Location } from "../src/location"
import { PermissionV2 } from "../src/permission"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { GlobTool } from "../src/tool/glob"
import { GrepTool } from "../src/tool/grep"
import { ToolRegistry } from "../src/tool/registry"
import { ToolOutputStore } from "../src/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

function workspace(
  allow: boolean,
  body: (root: string, assertions: PermissionV2.AssertInput[]) => Effect.Effect<void, unknown, ToolRegistry.Service>,
  onAssert?: (input: PermissionV2.AssertInput, root: string) => Promise<void>,
) {
  return Effect.acquireUseRelease(
    Effect.promise(tmpdir),
    (tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(tmp.path, "inside"))
          await fs.mkdir(path.join(tmp.path, "outside"))
          await fs.writeFile(path.join(tmp.path, "inside", "local.txt"), "needle local")
          await fs.writeFile(path.join(tmp.path, "outside", "private.txt"), "needle outside-canary")
        })
        const assertions: PermissionV2.AssertInput[] = []
        yield* body(tmp.path, assertions).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, GlobTool.node, GrepTool.node]), [
              [
                Location.node,
                Layer.succeed(
                  Location.Service,
                  location({ directory: AbsolutePath.make(path.join(tmp.path, "inside")) }),
                ),
              ],
              [
                PermissionV2.node,
                Layer.mock(PermissionV2.Service, {
                  assert: (input) =>
                    Effect.gen(function* () {
                      assertions.push(input)
                      if (input.action === "external_directory" && !allow)
                        return yield* new PermissionV2.BlockedError({ rules: [] })
                      if (onAssert) yield* Effect.promise(() => onAssert(input, tmp.path))
                    }),
                }),
              ],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ]),
          ),
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}

const call = (registry: ToolRegistry.Interface, tool: string, input: Record<string, unknown>) =>
  settleTool(registry, {
    sessionID: SessionSchema.ID.make("ses_search_permission"),
    ...toolIdentity,
    call: { type: "tool-call", id: "search-permission", name: tool, input },
  })

for (const tool of ["grep", "glob"]) {
  const pattern = tool === "grep" ? "needle" : "*.txt"
  it.live(`${tool} denies external directory before returning matches`, () =>
    workspace(false, (root, assertions) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const output = yield* call(registry, tool, { pattern, path: path.join(root, "outside") })
        expect(output.result.type).toBe("error")
        expect(JSON.stringify(output)).not.toContain("outside-canary")
        expect(assertions.map((item) => item.action)).toEqual(["external_directory"])
      }),
    ),
  )
  it.live(`${tool} permits explicitly approved external directory with canonical resource`, () =>
    workspace(true, (root, assertions) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const output = yield* call(registry, tool, { pattern, path: path.join(root, "outside") })
        expect(output.result.type).toBe("text")
        expect(JSON.stringify(output)).toContain("private.txt")
        expect(assertions.map((item) => item.action)).toEqual(["external_directory", tool])
        expect(assertions[0]!.resources[0]).toContain("outside")
      }),
    ),
  )
  it.live(`${tool} rejects relative escape and directory junction escape`, () =>
    workspace(true, (root) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        yield* Effect.promise(() =>
          fs.symlink(
            path.join(root, "outside"),
            path.join(root, "inside", "escape"),
            process.platform === "win32" ? "junction" : "dir",
          ),
        )
        for (const target of ["../outside", "escape", path.join(root, "inside", "escape")]) {
          const output = yield* call(registry, tool, { pattern, path: target })
          expect(output.result.type).toBe("error")
          expect(JSON.stringify(output)).not.toContain("outside-canary")
        }
        const recursive = yield* call(registry, tool, { pattern })
        expect(recursive.result.type).toBe("text")
        expect(JSON.stringify(recursive)).not.toContain("private.txt")
        expect(JSON.stringify(recursive)).not.toContain("outside-canary")
      }),
    ),
  )
  it.live(`${tool} refuses a directory replaced while permission is being approved`, () =>
    workspace(
      true,
      (root) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(root, "inside", "target")))
          const registry = yield* ToolRegistry.Service
          const output = yield* call(registry, tool, { pattern, path: "target" })
          expect(output.result.type).toBe("error")
          expect(JSON.stringify(output)).not.toContain("replacement-canary")
        }),
      async (input, root) => {
        if (input.action !== tool) return
        await fs.rename(path.join(root, "inside", "target"), path.join(root, "inside", "previous"))
        await fs.mkdir(path.join(root, "inside", "target"))
        await fs.writeFile(path.join(root, "inside", "target", "replacement-canary.txt"), "needle replacement-canary")
      },
    ),
  )
  it.live(`${tool} accepts internal default and absolute paths but does not search a missing path's parent`, () =>
    workspace(false, (root, assertions) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        for (const target of [undefined, path.join(root, "inside")]) {
          const output = yield* call(registry, tool, { pattern, ...(target ? { path: target } : {}) })
          expect(output.result.type).toBe("text")
          expect(JSON.stringify(output)).toContain("local.txt")
        }
        expect(assertions.every((item) => item.action === tool)).toBe(true)
        const missing = yield* call(registry, tool, { pattern, path: "missing.txt" })
        expect(missing.result.type).toBe("error")
        expect(JSON.stringify(missing)).not.toContain("local.txt")
      }),
    ),
  )
}

it.live("grep requires separate approval for an external single file", () =>
  workspace(false, (root, assertions) =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const output = yield* call(registry, "grep", {
        pattern: "needle",
        path: path.join(root, "outside", "private.txt"),
      })
      expect(output.result.type).toBe("error")
      expect(assertions.map((item) => item.action)).toEqual(["external_directory"])
    }),
  ),
)
