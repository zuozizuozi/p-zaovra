import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Location } from "../src/location"
import { PermissionV2 } from "../src/permission"
import { Ripgrep } from "../src/ripgrep"
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

function workspace(body: (directory: string) => Effect.Effect<void, unknown, ToolRegistry.Service | Ripgrep.Service>) {
  return Effect.acquireUseRelease(
    Effect.promise(tmpdir),
    (tmp) =>
      body(tmp.path).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, GlobTool.node, GrepTool.node, Ripgrep.node]), [
            [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
            [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ]),
        ),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}

const call = (registry: ToolRegistry.Interface, name: string, input: Record<string, unknown>) =>
  settleTool(registry, {
    sessionID: SessionSchema.ID.make("ses_search_bounds"),
    ...toolIdentity,
    call: { type: "tool-call", id: "search-bounds", name, input },
  })

it.live("K40 skips oversized raw JSON records and keeps normal matches on both sides", () =>
  workspace((directory) =>
    Effect.gen(function* () {
      const source = `needle before\nneedle ${"x".repeat(4 * 1024 * 1024)}\nneedle ${"中".repeat(30_000)}\nneedle after\n`
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "large.txt"), source))
      const ripgrep = yield* Ripgrep.Service
      const result = yield* ripgrep.grepSummary({ cwd: directory, pattern: "needle", limit: 100 })
      expect(result.items.map((row) => row.line)).toEqual([1, 4])
      expect(result).toMatchObject({ truncated: false, partial: true, skippedRecords: 2 })
      const registry = yield* ToolRegistry.Service
      const output = yield* call(registry, "grep", { pattern: "needle" })
      expect(output.output?.structured).toMatchObject({
        matches: [{ line: 1 }, { line: 4 }],
        partial: true,
        skippedRecords: 2,
      })
      expect(output.result).toMatchObject({ type: "text", value: expect.stringContaining("Partial search: 2") })
      const invalid = yield* ripgrep.grepSummary({ cwd: directory, pattern: "[", limit: 100 }).pipe(Effect.flip)
      expect(invalid._tag).toBe("Ripgrep.InvalidPatternError")
    }),
  ),
)

for (const tool of ["glob", "grep"])
  it.live(`K41 ${tool} defaults to 100 and preserves explicit limits and public array APIs`, () =>
    workspace((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: 110 }, (_, index) => fs.writeFile(path.join(directory, `f${index}.txt`), "needle\n")),
          ),
        )
        const registry = yield* ToolRegistry.Service
        const pattern = tool === "glob" ? "*.txt" : "needle"
        const first = yield* call(registry, tool, { pattern })
        const decoded =
          tool === "glob"
            ? yield* Schema.decodeUnknownEffect(GlobTool.Output)(first.output?.structured)
            : yield* Schema.decodeUnknownEffect(GrepTool.Output)(first.output?.structured)
        expect("entries" in decoded ? decoded.entries : decoded.matches).toHaveLength(100)
        expect(decoded).toMatchObject({ truncated: true, partial: false, skippedRecords: 0 })
        expect(first.result).toMatchObject({ type: "text", value: expect.stringContaining("Result limit reached") })
        const explicit = yield* call(registry, tool, { pattern, limit: 110 })
        expect(explicit.output?.structured).toMatchObject({ truncated: false, partial: false })
        const data = explicit.output?.structured as { entries?: unknown[]; matches?: unknown[] }
        expect(data.entries ?? data.matches).toHaveLength(110)
        const ripgrep = yield* Ripgrep.Service
        const publicResult = yield* tool === "glob"
          ? ripgrep.glob({ cwd: directory, pattern, limit: 110 })
          : ripgrep.grep({ cwd: directory, pattern, limit: 110 })
        expect(Array.isArray(publicResult)).toBe(true)
        expect(publicResult).toHaveLength(110)
      }),
    ),
  )
