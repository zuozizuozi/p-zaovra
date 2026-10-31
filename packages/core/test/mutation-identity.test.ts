import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { FileMutation } from "../src/file-mutation"
import { FileBackup } from "../src/file-backup"
import { LocationMutation } from "../src/location-mutation"
import { Location } from "../src/location"
import { Global } from "../src/global"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { location } from "./fixture/location"
import { it } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

for (const scenario of [
  "same-content-replacement",
  "concurrent-content",
  "symlink-escape",
  "parent-escape",
  "opened-path-replaced",
  "post-write-replacement",
] as const)
  it.live(
    `469 pinned mutation rejects ${scenario} and retains evidence`,
    () =>
      Effect.acquireUseRelease(
        Effect.promise(async () => {
          const tmp = await tmpdir()
          // The same suite runs inside the original task image with a directory on
          // its overlay mount; ordinary runs use the redirected test TEMP.
          const directory = process.env.ZAOVRA_OVERLAY_TEST_DIRECTORY
            ? await fs.mkdtemp(path.join(process.env.ZAOVRA_OVERLAY_TEST_DIRECTORY, "p1-identity-"))
            : path.join(tmp.path, "root")
          await fs.mkdir(directory, { recursive: true })
          return { tmp, directory }
        }),
        ({ tmp, directory }) =>
          Effect.gen(function* () {
            const nested = path.join(directory, "nested")
            yield* Effect.promise(() => fs.mkdir(nested))
            const file = path.join(nested, "file.txt")
            const replacement = path.join(directory, "replacement.txt")
            const outside = path.join(tmp.path, "outside.txt")
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(file, "before"),
                fs.writeFile(replacement, "before"),
                fs.writeFile(outside, "outside"),
              ]),
            )
            const program = Effect.gen(function* () {
              const mutation = yield* LocationMutation.Service
              const files = yield* FileMutation.Service
              const target = yield* mutation.resolve({ path: file, kind: "file" })
              let calls = 0
              let changed = false
              const validate = Effect.gen(function* () {
                calls++
                const afterWrite =
                  (yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => "missing"))) === "after"
                if (
                  !changed &&
                  (scenario === "post-write-replacement"
                    ? afterWrite
                    : calls === (scenario === "opened-path-replaced" ? 5 : 3))
                ) {
                  changed = true
                  yield* Effect.promise(async () => {
                    if (scenario === "concurrent-content") {
                      await fs.writeFile(file, "concurrent")
                      return
                    }
                    if (scenario === "parent-escape") {
                      await fs.rename(nested, path.join(directory, "old-parent"))
                      await fs.symlink(tmp.path, nested, process.platform === "win32" ? "junction" : "dir")
                      return
                    }
                    if (scenario === "symlink-escape") {
                      await fs.unlink(file)
                      await fs.symlink(outside, file)
                      return
                    }
                    await fs.rename(replacement, file)
                  })
                }
                const current = yield* mutation
                  .resolve({ path: file, kind: "file" })
                  .pipe(Effect.mapError(() => new FileMutation.TargetChangedError({ path: file })))
                if (
                  current.identity !== target.identity ||
                  current.canonical !== target.canonical ||
                  current.resource !== target.resource
                )
                  return yield* new FileMutation.TargetChangedError({ path: file })
              })
              const result = yield* files
                .writeTextPreservingBom({
                  target,
                  validate,
                  expected: "before",
                  content: "after",
                  sessionID: SessionV2.ID.make("ses_identity_guard"),
                })
                .pipe(Effect.exit)
              expect(result._tag).toBe("Failure")
              expect(changed).toBe(true)
              expect(yield* Effect.promise(() => fs.readFile(outside, "utf8"))).toBe("outside")
              expect(yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => "missing"))).not.toBe("after")
              if (scenario === "post-write-replacement") {
                const storage = path.join(
                  FileBackup.directory(path.join(tmp.path, "data"), SessionV2.ID.make("ses_identity_guard")),
                  FileBackup.hash(new TextEncoder().encode(directory)),
                )
                const journal = yield* Effect.promise(() => Bun.file(path.join(storage, "journal.json")).json())
                expect(journal.pending).toMatchObject([
                  { phase: "isolated", before: { hash: FileBackup.hash(new TextEncoder().encode("before")) } },
                ])
                expect(
                  yield* Effect.promise(() =>
                    Bun.file(path.join(storage, FileBackup.hash(new TextEncoder().encode("before")))).text(),
                  ),
                ).toBe("before")
              }
            })
            return yield* program.pipe(
              Effect.provide(
                AppNodeBuilder.build(LayerNode.group([FileMutation.node, LocationMutation.node, FileBackup.node]), [
                  [
                    Location.node,
                    Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(directory) })),
                  ],
                  [Global.node, Global.layerWith({ data: path.join(tmp.path, "data") })],
                ]),
              ),
            )
          }),
        ({ tmp }) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    30000,
  )
