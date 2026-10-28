import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FileMutation } from "@zaovra-ai/core/file-mutation"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { Global } from "@zaovra-ai/core/global"
import { Location } from "@zaovra-ai/core/location"
import { LocationMutation } from "@zaovra-ai/core/location-mutation"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { ToolOutputStore } from "@zaovra-ai/core/tool-output-store"
import { WriteTool } from "@zaovra-ai/core/tool/write"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_write_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const writes: string[] = []
// Keep every project-write assertion; private backup I/O is checked separately.
const projectWrites = () =>
  writes.filter((file) => !FSUtil.contains(path.join(Global.Path.data, "session-file-backup"), file))
let denyAction: string | undefined
let afterRead: ((target: string) => Promise<void>) | undefined
let onApproval: ((input: PermissionV2.AssertInput) => Promise<void>) | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(() => (onApproval ? Effect.promise(() => onApproval!(input)) : Effect.void)),
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const reset = () => {
  assertions.length = 0
  writes.length = 0
  denyAction = undefined
  onApproval = undefined
  afterRead = undefined
}

const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      readFile: (target) =>
        fs
          .readFile(target)
          .pipe(Effect.tap(() => (afterRead ? Effect.promise(() => afterRead!(target)) : Effect.void))),
      writeWithDirs: (target, content, mode) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeWithDirs(target, content, mode))),
      writeFileString: (target, content, options) =>
        fs.writeFileString(target, content, options).pipe(Effect.tap(() => Effect.sync(() => writes.push(target)))),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          FileMutation.node,
          WriteTool.node,
        ]),
        [
          [FSUtil.node, filesystem],
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (input: typeof WriteTool.Input.Type, id = "call-write") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "write", input },
})

const it = testEffect(Layer.empty)

describe("WriteTool", () => {
  it.live("rejects blind and stale replacement without changing existing content", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "index.html"), "user work")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const blind = yield* executeTool(registry, call({ path: "index.html", content: "replacement" }))
                expect(blind.type).toBe("error")
                expect(blind).toMatchObject({ value: expect.stringContaining("Nothing was overwritten") })
                const stale = yield* executeTool(
                  registry,
                  call({ path: "index.html", content: "replacement", expectedContent: "old work" }, "stale"),
                )
                expect(stale).toMatchObject({ type: "error", value: expect.stringContaining("does not match") })
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "index.html"), "utf8"))).toBe(
                  "user work",
                )
                expect(writes).toEqual([])
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("registers and creates a relative file through FileMutation once", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["write"])
            const settled = yield* settleTool(registry, call({ path: "src/new.txt", content: "created" }))
            expect(settled).toEqual({
              result: { type: "text", value: "Created file successfully: src/new.txt" },
              output: {
                structured: {
                  operation: "write",
                  target: path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "src", "new.txt"),
                  resource: "src/new.txt",
                  existed: false,
                },
                content: [{ type: "text", text: "Created file successfully: src/new.txt" }],
              },
            })
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "src", "new.txt"), "utf8"))).toBe(
              "created",
            )
            expect(assertions).toMatchObject([{ sessionID, action: "edit", resources: ["src/new.txt"], save: ["*"] }])
            expect(projectWrites()).toEqual([
              path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "src", "new.txt"),
            ])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("overwrites a relative existing file and reports that it wrote the file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "existing.txt"), "before")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              settleTool(registry, call({ path: "existing.txt", content: "after", expectedContent: "before" })),
            ),
          ),
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.result).toEqual({ type: "text", value: "Wrote file successfully: existing.txt" })
              expect(settled.output?.structured).toMatchObject({ resource: "existing.txt", existed: true })
              expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "existing.txt"), "utf8"))).toBe(
                "after",
              )
              expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "existing.txt"), "utf8"))).toBe(
                "after",
              )
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves exactly one BOM when overwriting existing files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const preserved = path.join(tmp.path, "preserved.txt")
        const deduplicated = path.join(tmp.path, "deduplicated.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(preserved, "\uFEFFbefore"), fs.writeFile(deduplicated, "\uFEFFbefore")]),
        ).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                yield* settleTool(
                  registry,
                  call({ path: "preserved.txt", content: "after", expectedContent: "before" }, "call-preserved"),
                )
                yield* settleTool(
                  registry,
                  call(
                    { path: "deduplicated.txt", content: "\uFEFFafter", expectedContent: "\uFEFFbefore" },
                    "call-deduplicated",
                  ),
                )

                expect(yield* Effect.promise(() => fs.readFile(preserved, "utf8"))).toBe("\uFEFFafter")
                expect(yield* Effect.promise(() => fs.readFile(deduplicated, "utf8"))).toBe("\uFEFFafter")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("accepts an absolute file path inside the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "absolute.txt")
        return withTool(tmp.path, (registry) => executeTool(registry, call({ path: target, content: "inside" }))).pipe(
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result).toEqual({ type: "text", value: "Created file successfully: absolute.txt" })
              expect(assertions.map((input) => input.action)).toEqual(["edit"])
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("inside")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("approves an explicit external absolute path before edit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const target = path.join(outside.path, "external.txt")
        return withTool(active.path, (registry) =>
          settleTool(registry, call({ path: target, content: "external" })),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              const canonicalTarget = path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "external.txt")
              expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
              expect(assertions[0]).toMatchObject({
                resources: [
                  path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "*").replaceAll("\\", "/"),
                ],
              })
              expect(assertions[1]).toMatchObject({ resources: [canonicalTarget.replaceAll("\\", "/")], save: ["*"] })
              expect(settled.output?.structured).toMatchObject({
                target: canonicalTarget,
                resource: canonicalTarget.replaceAll("\\", "/"),
                existed: false,
              })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("external")
              expect(writes).toEqual([canonicalTarget])
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not write when external_directory or edit approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          const external = path.join(outside.path, "denied.txt")
          reset()
          denyAction = "external_directory"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: external, content: "blocked" })),
            ),
          ).toEqual({
            type: "error",
            value:
              "Tool not executed: permission policy blocked this action. Use an already permitted action or ask the user to change permission.",
          })
          expect(assertions.map((input) => input.action)).toEqual(["external_directory"])
          expect(writes).toEqual([])

          reset()
          denyAction = "edit"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: "denied.txt", content: "blocked" })),
            ),
          ).toEqual({
            type: "error",
            value:
              "Tool not executed: permission policy blocked this action. Use an already permitted action or ask the user to change permission.",
          })
          expect(assertions.map((input) => input.action)).toEqual(["edit"])
          expect(writes).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )
})

test("keeps the locked write schema, semantics docstring, and deferred UX TODOs visible", async () => {
  const source = (await fs.readFile(new URL("../src/tool/write.ts", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  const definition = await Effect.runPromise(
    withTool(path.dirname(fileURLToPath(import.meta.url)), (registry) => toolDefinitions(registry)),
  )
  const schema = definition[0]?.inputSchema as { readonly properties?: Record<string, unknown> }

  expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["content", "expectedContent", "path"])
  expect(source).toContain(
    "absolute external paths retain mutation capability through a separate\n * external_directory approval before edit approval.",
  )
  for (const todo of [
    "Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.",
    "Publish watcher/file-edit events after V2 watcher integration exists.",
    "Add snapshots / undo after design exists.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})

it.live("formats actual write output and reports a failed formatter", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        reset()
        yield* Effect.promise(() =>
          Bun.write(
            path.join(tmp.path, "zaovra.json"),
            JSON.stringify({
              formatter: {
                custom: {
                  extensions: [".audit"],
                  command: [
                    process.execPath,
                    "-e",
                    "require('fs').appendFileSync(process.argv[1], ' formatted')",
                    "$FILE",
                  ],
                },
                failing: { extensions: [".audit"], command: [process.execPath, "-e", "process.exit(1)"] },
              },
              lsp: {
                missing: { extensions: [".audit"], command: ["zaovra-nonexistent-lsp-tool-test"] },
                test: {
                  extensions: [".audit"],
                  command: [
                    process.execPath,
                    path.join(import.meta.dirname, "fixture/lsp-diagnostics.cjs"),
                    path.join(tmp.path, "lsp.log"),
                  ],
                },
              },
            }),
          ),
        )
        yield* withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const settled = yield* settleTool(registry, call({ path: "new.audit", content: "bad" }))
            expect(settled.output?.structured).toMatchObject({ formatting: { ran: ["custom"], failed: ["failing"] } })
            expect(settled.result.type).toBe("text")
            expect(settled.result.value).toContain("Automatic formatting failed: failing")
            expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "new.audit")).text())).toBe("bad formatted")
            expect(settled.output?.structured).toMatchObject({
              lsp: {
                diagnostics: { [path.join(tmp.path, "new.audit")]: [{ message: "Bad text" }] },
                failed: ["missing"],
              },
            })
            expect(settled.result.value).toContain("ERROR: Bad text")
            expect(settled.result.value).toContain(
              "Language diagnostics unavailable: missing. File changes remain saved.",
            )
          }),
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

for (const swap of ["junction", "directory", "file"])
  it.live("302 N3 approval target identity change stops write: " + swap, () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          reset()
          const approved = path.join(tmp.path, "approved"),
            other = path.join(tmp.path, "other"),
            link = path.join(tmp.path, "link")
          yield* Effect.promise(async () => {
            await fs.mkdir(approved)
            await fs.mkdir(other)
            await fs.writeFile(path.join(approved, "target.txt"), "before")
            await fs.writeFile(path.join(other, "target.txt"), "before")
            if (swap === "junction") await fs.symlink(approved, link, process.platform === "win32" ? "junction" : "dir")
          })
          onApproval = async (input) => {
            if (input.action !== "edit") return
            onApproval = undefined
            if (swap === "junction") {
              await fs.unlink(link)
              await fs.symlink(other, link, process.platform === "win32" ? "junction" : "dir")
              return
            }
            if (swap === "directory") {
              await fs.rename(approved, approved + "-old")
              await fs.rename(other, approved)
              return
            }
            await fs.rename(path.join(approved, "target.txt"), path.join(approved, "old.txt"))
            await fs.writeFile(path.join(approved, "target.txt"), "before")
          }
          const result = yield* withTool(tmp.path, (registry) =>
            executeTool(
              registry,
              call({
                path: path.join(swap === "junction" ? "link" : "approved", "target.txt"),
                content: "after",
                expectedContent: "before",
              }),
            ),
          )
          expect(result.type).toBe("error")
          expect(JSON.stringify(result)).toContain("changed")
          expect(yield* Effect.promise(() => fs.readFile(path.join(approved, "target.txt"), "utf8"))).toBe("before")
          expect(writes).toHaveLength(0)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

it.live("302 N3 replacement between content read and commit cannot truncate the new inode", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        reset()
        const target = path.join(tmp.path, "race.txt")
        yield* Effect.promise(() => fs.writeFile(target, "before"))
        afterRead = async (file) => {
          if (file !== target) return
          afterRead = undefined
          await fs.rename(target, target + ".old")
          await fs.writeFile(target, "before")
        }
        const result = yield* withTool(tmp.path, (registry) =>
          executeTool(registry, call({ path: "race.txt", content: "after", expectedContent: "before" })),
        )
        expect(result.type).toBe("error")
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before")
        expect(yield* Effect.promise(() => fs.readFile(target + ".old", "utf8"))).toBe("before")
        expect(writes).toHaveLength(0)
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("302 N3 prospective junction redirected outside Location creates nothing", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        reset()
        const active = path.join(tmp.path, "active"),
          approved = path.join(active, "approved"),
          outside = path.join(tmp.path, "outside"),
          link = path.join(active, "link")
        yield* Effect.promise(async () => {
          await fs.mkdir(approved, { recursive: true })
          await fs.mkdir(outside)
          await fs.symlink(approved, link, process.platform === "win32" ? "junction" : "dir")
        })
        onApproval = async (input) => {
          if (input.action !== "edit") return
          onApproval = undefined
          await fs.unlink(link)
          await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
        }
        const result = yield* withTool(active, (registry) =>
          executeTool(registry, call({ path: "link/new.txt", content: "unauthorized" })),
        )
        expect(result.type).toBe("error")
        expect(yield* Effect.promise(() => Bun.file(path.join(outside, "new.txt")).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(path.join(approved, "new.txt")).exists())).toBe(false)
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
