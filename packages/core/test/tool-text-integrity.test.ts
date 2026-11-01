import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { FSUtil } from "../src/fs-util"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { PermissionV2 } from "../src/permission"
import { AbsolutePath, RelativePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { Snapshot } from "../src/snapshot"
import { ApplyPatchTool } from "../src/tool/apply-patch"
import { EditTool } from "../src/tool/edit"
import { ReadTool } from "../src/tool/read"
import { ToolRegistry } from "../src/tool/registry"
import { ToolOutputStore } from "../src/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const sessionID = SessionSchema.ID.make("ses_text_integrity")
const invalid = {
  gbk: Buffer.from([
    0x2f, 0x2f, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xa2, 0xca, 0xcd, 0x0a, 0x69, 0x6e, 0x74, 0x20, 0x78, 0x3d, 0x31,
    0x3b, 0x0a,
  ]),
  latin1: Buffer.concat([Buffer.from("// caf"), Buffer.from([0xe9]), Buffer.from("\nint x=1;\n")]),
}

const patch = (file: string, from = "int x=1;", to = "int x=2;") => `*** Update File: ${file}\n@@\n-${from}\n+${to}\n`

const call = (registry: ToolRegistry.Interface, name: string, input: Record<string, unknown>, id = "call_text") =>
  settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id, name, input } })

const change = (registry: ToolRegistry.Interface, tool: string, from = "int x=1;", to = "int x=2;") =>
  call(
    registry,
    tool,
    tool === "edit"
      ? { path: "source.txt", oldString: from, newString: to }
      : { patchText: `*** Begin Patch\n${patch("source.txt", from, to)}*** End Patch` },
    `call_${from}`,
  )

function workspace(
  files: Record<string, string | Uint8Array>,
  body: (
    directory: string,
    writes: readonly string[],
  ) => Effect.Effect<void, unknown, ToolRegistry.Service | Snapshot.Service>,
) {
  return Effect.acquireUseRelease(
    Effect.promise(tmpdir),
    (tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all(Object.entries(files).map(([name, bytes]) => fs.writeFile(path.join(tmp.path, name), bytes))),
        )
        const writes: string[] = []
        const targets = new Set([...Object.keys(files), "added.txt"].map((name) => path.join(tmp.path, name)))
        const filesystem = Layer.effect(
          FSUtil.Service,
          Effect.gen(function* () {
            const actual = yield* FSUtil.Service
            const record = (target: string) =>
              Effect.sync(() => {
                if (targets.has(target)) writes.push(target)
              })
            return FSUtil.Service.of({
              ...actual,
              writeFile: (target, bytes, options) =>
                record(target).pipe(Effect.andThen(actual.writeFile(target, bytes, options))),
              writeFileString: (target, text, options) =>
                record(target).pipe(Effect.andThen(actual.writeFileString(target, text, options))),
              remove: (target, options) => record(target).pipe(Effect.andThen(actual.remove(target, options))),
            })
          }),
        ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
        yield* body(tmp.path, writes).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([ToolRegistry.node, EditTool.node, ApplyPatchTool.node, ReadTool.node, Snapshot.node]),
              [
                [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
                [Global.node, Global.layerWith({ data: path.join(tmp.path, "private-data") })],
                [FSUtil.node, filesystem],
                [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
                [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
              ],
            ),
          ),
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}

for (const tool of ["edit", "apply_patch"])
  for (const [encoding, bytes] of Object.entries(invalid))
    it.live(`K39 ${tool} rejects invalid ${encoding} before any mutation`, () =>
      workspace({ "source.txt": bytes }, (directory, writes) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const snapshots = yield* Snapshot.Service
          const before = yield* snapshots.capture({ sessionID })
          expect(before).toBeDefined()
          const result = yield* change(registry, tool)
          expect(result.result).toMatchObject({ type: "error", value: expect.stringContaining("UTF-8") })
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(bytes)
          expect(writes).toHaveLength(0)
          const after = yield* snapshots.capture({ sessionID })
          expect(yield* snapshots.files({ from: before!, to: after! })).toEqual([])
        }),
      ),
    )

for (const tool of ["edit", "apply_patch"])
  for (const bom of ["", "\uFEFF"])
    for (const ending of ["\n", "\r\n"])
      it.live(
        `K39 ${tool} preserves UTF-8 Chinese/BOM=${!!bom}/${JSON.stringify(ending)} across consecutive edits and restore`,
        () =>
          workspace({ "source.txt": `${bom}// 中文注释${ending}int x=1;${ending}` }, (directory) =>
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              const snapshots = yield* Snapshot.Service
              const before = yield* snapshots.capture({ sessionID })
              expect(before).toBeDefined()
              for (const [from, to] of [
                ["int x=1;", "int x=2;"],
                ["int x=2;", "int x=3;"],
              ]) {
                expect((yield* change(registry, tool, from, to)).result.type).not.toBe("error")
                expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
                  Buffer.from(`${bom}// 中文注释${ending}${to}${ending}`),
                )
              }
              const after = yield* snapshots.capture({ sessionID })
              expect(after).toBeDefined()
              yield* snapshots.restore({ files: new Map([[RelativePath.make("source.txt"), before!]]) })
              expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
                Buffer.from(`${bom}// 中文注释${ending}int x=1;${ending}`),
              )
              yield* snapshots.restore({ files: new Map([[RelativePath.make("source.txt"), after!]]) })
              expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
                Buffer.from(`${bom}// 中文注释${ending}int x=3;${ending}`),
              )
            }),
          ),
      )

for (const tool of ["edit", "apply_patch"])
  it.live(`K39 ${tool} explicitly rejects mixed LF/CRLF without normalizing the file`, () =>
    workspace({ "source.txt": "// 中文\r\nint x=1;\n" }, (directory, writes) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const result = yield* change(registry, tool)
        expect(result.result).toMatchObject({ type: "error", value: expect.stringContaining("mixed") })
        expect(writes).toHaveLength(0)
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
          Buffer.from("// 中文\r\nint x=1;\n"),
        )
      }),
    ),
  )

for (const [encoding, bytes] of Object.entries({ ...invalid, mixed: Buffer.from("// 中文\r\nint x=1;\n") }))
  for (const position of ["first", "last"])
    it.live(`K39 multi-file patch ${encoding}/${position} preflights before add, delete or valid update`, () =>
      workspace({ "bad.txt": bytes, "good.txt": "int x=1;\n", "removed.txt": "keep me\n" }, (directory, writes) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const other = `*** Add File: added.txt\n+added\n*** Delete File: removed.txt\n${patch("good.txt")}`
          const result = yield* call(registry, "apply_patch", {
            patchText: `*** Begin Patch\n${position === "first" ? patch("bad.txt") + other : other + patch("bad.txt")}*** End Patch`,
          })
          expect(result.result).toMatchObject({
            type: "error",
            value: expect.stringContaining(encoding === "mixed" ? "mixed" : "UTF-8"),
          })
          expect(writes).toHaveLength(0)
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "bad.txt")))).toEqual(bytes)
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "good.txt"), "utf8"))).toBe("int x=1;\n")
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "removed.txt"), "utf8"))).toBe(
            "keep me\n",
          )
          expect(yield* Effect.promise(() => Bun.file(path.join(directory, "added.txt")).exists())).toBe(false)
        }),
      ),
    )

for (const [encoding, bytes] of Object.entries(invalid))
  it.live(`K39 read returns an actionable ${encoding} encoding failure without mutation`, () =>
    workspace({ "source.txt": bytes }, (_directory, writes) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        expect((yield* call(registry, "read", { path: "source.txt" })).result).toMatchObject({
          type: "error",
          value: expect.stringContaining("UTF-8"),
        })
        expect(writes).toHaveLength(0)
      }),
    ),
  )

it.live("K39 does not reinterpret an authorized raw deletion as a text update", () =>
  workspace({ "source.txt": invalid.gbk }, (directory) =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(
        (yield* call(registry, "apply_patch", {
          patchText: "*** Begin Patch\n*** Delete File: source.txt\n*** End Patch",
        })).result.type,
      ).not.toBe("error")
      expect(yield* Effect.promise(() => Bun.file(path.join(directory, "source.txt")).exists())).toBe(false)
    }),
  ),
)
