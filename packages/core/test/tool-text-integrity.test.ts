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

const patch = (file: string, from = "int x=1;", to = "int x=2;") =>
  `*** Update File: ${file}\n@@\n${from
    .split("\n")
    .map((line) => "-" + line)
    .join("\n")}\n${to
    .split("\n")
    .map((line) => "+" + line)
    .join("\n")}\n`

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
  for (const bom of ["", "\uFEFF", "\uFEFF\uFEFF"])
    for (const ending of ["\n", "\r\n"])
      it.live(
        `K39 ${tool} preserves UTF-8 Chinese/BOMbytes=${Buffer.byteLength(bom)}/${JSON.stringify(ending)} across consecutive edits and restore`,
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
  for (const bom of ["", "\uFEFF", "\uFEFF\uFEFF"])
    it.live(
      `K39 ${tool} preserves mixed endings and BOMbytes=${Buffer.byteLength(bom)} across regional edits and undo/redo`,
      () =>
        workspace(
          {
            "source.txt": `${bom}// 中文\nint x=1;\r\nint y=1;\n// 尾部\r\nlast`,
            "zaovra.json": JSON.stringify({
              formatter: {
                normalize: {
                  extensions: [".txt"],
                  command: [
                    process.execPath,
                    "-e",
                    "require('fs').writeFileSync(process.argv[1], 'NORMALIZED\\n')",
                    "$FILE",
                  ],
                },
              },
            }),
          },
          (directory) =>
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              const snapshots = yield* Snapshot.Service
              const before = yield* snapshots.capture({ sessionID })
              for (const [from, to] of [
                ["int x=1;", "int x=2;\n// added CRLF"],
                ["int y=1;", "int y=2;\n// added LF"],
                ["int x=2;", "int x=3;"],
              ]) {
                expect((yield* change(registry, tool, from, to)).result.type).not.toBe("error")
              }
              const expected = `${bom}// 中文\nint x=3;\r\n// added CRLF\r\nint y=2;\n// added LF\n// 尾部\r\nlast`
              expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
                Buffer.from(expected),
              )
              const after = yield* snapshots.capture({ sessionID })
              yield* snapshots.restore({ files: new Map([[RelativePath.make("source.txt"), before!]]) })
              expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
                Buffer.from(`${bom}// 中文\nint x=1;\r\nint y=1;\n// 尾部\r\nlast`),
              )
              yield* snapshots.restore({ files: new Map([[RelativePath.make("source.txt"), after!]]) })
              expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
                Buffer.from(expected),
              )
            }),
        ),
    )

for (const [label, before, from, to, expected] of [
  ["majority CRLF", "header\na\r\nb\r\nc\nsuffix\r\n", "a\r\nb\r\nc\n", "x\ny\n", "header\nx\r\ny\r\nsuffix\r\n"],
  ["CRLF fallback", "header\na\r\nb\r\nsuffix\n", "a\nb\n", "x\ny\n", "header\nx\r\ny\r\nsuffix\n"],
  ["LF fallback", "header\r\na\nb\nsuffix\r\n", "a\r\nb\r\n", "x\r\ny\r\n", "header\r\nx\ny\nsuffix\r\n"],
  ["tie, first LF", "header\r\na\nb\r\nsuffix\n", "a\nb\r\n", "x\ny\n", "header\r\nx\ny\nsuffix\n"],
  ["tie, first CRLF", "header\na\r\nb\nsuffix\r\n", "a\r\nb\n", "x\ny\n", "header\nx\r\ny\r\nsuffix\r\n"],
  [
    "raw exact priority",
    "header\nsame\r\nx\r\nsame\nx\nsuffix\r\n",
    "same\nx\n",
    "changed\n",
    "header\nsame\r\nx\r\nchanged\nsuffix\r\n",
  ],
])
  it.live(`K39 edit matches the original region first and uses ${label}`, () =>
    workspace({ "source.txt": before! }, (directory) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        expect((yield* change(registry, "edit", from!, to!)).result.type).not.toBe("error")
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
          Buffer.from(expected!),
        )
      }),
    ),
  )

it.live("K39 edit replaceAll inherits the style of each occurrence without normalizing other lines", () =>
  workspace({ "source.txt": "same\r\nsame\nlast" }, (directory) =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(
        (yield* call(registry, "edit", {
          path: "source.txt",
          oldString: "same",
          newString: "new\nextra",
          replaceAll: true,
        })).result.type,
      ).not.toBe("error")
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
        Buffer.from("new\r\nextra\r\nnew\nextra\nlast"),
      )
    }),
  ),
)

it.live("K39 apply_patch preserves fuzzy-matched context bytes and only changes the requested line", () =>
  workspace({ "source.txt": "  keep;  \r\nint x=1;\nnext\r\nlast" }, (directory) =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(
        (yield* call(registry, "apply_patch", {
          patchText:
            "*** Begin Patch\n*** Update File: source.txt\n@@\n keep;\n-int x=1;\n+int x=2;\n next\n*** End Patch",
        })).result.type,
      ).not.toBe("error")
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
        Buffer.from("  keep;  \r\nint x=2;\nnext\r\nlast"),
      )
    }),
  ),
)

for (const [label, before, body, expected] of [
  ["append after unterminated CRLF neighbor", "head\r\nlast", "+added", "head\r\nlast\r\nadded\r\n"],
  ["replace unterminated EOF", "head\r\nlast", "-last\n+last2", "head\r\nlast2"],
  ["expand unterminated EOF", "head\r\nlast", "-last\n+one\n+two", "head\r\none\r\ntwo"],
  ["delete a middle LF line", "head\r\nremove\nlast", "-remove", "head\r\nlast"],
  ["empty file insertion", "", "+added", "added\n"],
])
  it.live(`K39 apply_patch ${label} preserves untouched boundaries`, () =>
    workspace({ "source.txt": before! }, (directory) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        expect(
          (yield* call(registry, "apply_patch", {
            patchText: `*** Begin Patch\n*** Update File: source.txt\n@@\n${body}\n*** End Patch`,
          })).result.type,
        ).not.toBe("error")
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
          Buffer.from(expected!),
        )
      }),
    ),
  )

for (const [encoding, bytes] of Object.entries(invalid))
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
            value: expect.stringContaining("UTF-8"),
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

function patchRoundTrip(before: string, body: string, expected: string) {
  const untouched = Buffer.from("untouched\r\n保留\nlast")
  return workspace({ "source.txt": before, "untouched.txt": untouched }, (directory) =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const snapshots = yield* Snapshot.Service
      const initial = yield* snapshots.capture({ sessionID })
      expect(initial).toBeDefined()
      expect(
        (yield* call(registry, "apply_patch", {
          patchText: `*** Begin Patch\n*** Update File: source.txt\n${body}\n*** End Patch`,
        })).result.type,
      ).not.toBe("error")
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
        Buffer.from(expected),
      )
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "untouched.txt")))).toEqual(untouched)
      const applied = yield* snapshots.capture({ sessionID })
      expect(applied).toBeDefined()
      yield* snapshots.restore({ files: new Map([[RelativePath.make("source.txt"), initial!]]) })
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(Buffer.from(before))
      yield* snapshots.restore({ files: new Map([[RelativePath.make("source.txt"), applied!]]) })
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
        Buffer.from(expected),
      )
      expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "untouched.txt")))).toEqual(untouched)
    }),
  )
}

for (const bom of ["", "\uFEFF", "\uFEFF\uFEFF"])
  for (const region of [
    { name: "no-neighbor", prefix: "", ending: "\n" },
    { name: "LF", prefix: "head\nkeep\n", ending: "\n" },
    { name: "CRLF", prefix: "head\r\nkeep\r\n", ending: "\r\n" },
    { name: "mixed-nearest-LF", prefix: "head\r\nkeep\n", ending: "\n" },
    { name: "mixed-nearest-CRLF", prefix: "head\nkeep\r\n", ending: "\r\n" },
  ])
    for (const fuzzy of [false, true])
      for (const added of [["b"], ["b", "c"]])
        for (const multipleChunks of region.prefix ? [false, true] : [false])
          it.live(
            `K39 EOF context append ${region.name}/BOM${Buffer.byteLength(bom)}/fuzzy${fuzzy}/${added.length} lines/multi${multipleChunks} preserves bytes and undo-redo`,
            () => {
              const tail = fuzzy ? "  a  " : "a"
              const before = bom + region.prefix + tail
              const body =
                (multipleChunks ? "@@\n-keep\n+KEEP\n" : "") +
                "@@\n a\n" +
                added.map((line) => "+" + line).join("\n") +
                (added.length > 1 ? "\n*** End of File" : "")
              const expected =
                bom +
                (multipleChunks ? region.prefix.replace("keep", "KEEP") : region.prefix) +
                tail +
                region.ending +
                added.join(region.ending) +
                region.ending
              return patchRoundTrip(before, body, expected)
            },
          )

for (const bom of ["", "\uFEFF", "\uFEFF\uFEFF"])
  for (const endings of [
    ["\r\n", "\n"],
    ["\n", "\r\n"],
  ])
    for (const fuzzy of [false, true])
      for (const deleteFirst of [false, true])
        it.live(
          `K39 repeated context retains its actual line/BOM${Buffer.byteLength(bom)}/${JSON.stringify(endings)}/fuzzy${fuzzy}/deleteFirst${deleteFirst}`,
          () => {
            const first = (fuzzy ? "same  " : "same") + endings[0]!
            const second = (fuzzy ? "  same" : "same") + endings[1]!
            return patchRoundTrip(
              bom + "head\r\n" + first + second,
              "@@\n" + (deleteFirst ? "-same\n same" : " same\n-same"),
              bom + "head\r\n" + (deleteFirst ? second : first),
            )
          },
        )

for (const bom of ["", "\uFEFF", "\uFEFF\uFEFF"])
  it.live(`K39 retained EOF without additions stays unterminated/BOM${Buffer.byteLength(bom)}`, () =>
    workspace({ "source.txt": bom + "head\r\n  a  " }, (directory) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const snapshots = yield* Snapshot.Service
        const before = yield* snapshots.capture({ sessionID })
        expect(
          (yield* call(registry, "apply_patch", {
            patchText: "*** Begin Patch\n*** Update File: source.txt\n@@\n a\n*** End Patch",
          })).result.type,
        ).not.toBe("error")
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "source.txt")))).toEqual(
          Buffer.from(bom + "head\r\n  a  "),
        )
        const after = yield* snapshots.capture({ sessionID })
        expect(yield* snapshots.files({ from: before!, to: after! })).toEqual([])
      }),
    ),
  )

for (const [label, before, body, expected] of [
  ["virtual EOF context", "a\n", "@@\n a\n \n+b", "a\n\nb\n"],
  ["retained empty context", "head\r\n\r\nlast", "@@\n-head\n+HEAD\n \n last\n+b", "HEAD\r\n\r\nlast\r\nb\r\n"],
])
  it.live(`K39 EOF ${label} keeps context offsets and local line boundaries`, () =>
    patchRoundTrip(before!, body!, expected!),
  )
