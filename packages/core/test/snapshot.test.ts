import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Logger } from "effect"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { Global } from "@zaovra-ai/core/global"
import { Location } from "@zaovra-ai/core/location"
import { AbsolutePath, RelativePath } from "@zaovra-ai/core/schema"
import { Snapshot } from "@zaovra-ai/core/snapshot"
import { Hash } from "@zaovra-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

describe("Snapshot", () => {
  for (const split of [false, true])
    for (const repair of [false, true])
      testEffect(Layer.empty).live(
        `84-S1 captures and restores ${split ? "split-index" : "ordinary index"} source, repair=${repair}`,
        () =>
          Effect.acquireUseRelease(
            Effect.promise(() => tmpdir()),
            (tmp) =>
              Effect.gen(function* () {
                const project = path.join(tmp.path, "project")
                const data = path.join(tmp.path, "data")
                yield* Effect.promise(async () => {
                  await fs.mkdir(project)
                  await fs.writeFile(path.join(project, "tracked.txt"), "committed\n")
                  await fs.writeFile(path.join(project, ".gitignore"), "ignored.txt\nforce.txt\n")
                  await $`git init`.cwd(project).quiet()
                  await $`git config core.autocrlf false`.cwd(project).quiet()
                  await $`git config commit.gpgsign false`.cwd(project).quiet()
                  await $`git config user.email test@zaovra.test`.cwd(project).quiet()
                  await $`git config user.name Test`.cwd(project).quiet()
                  await $`git add .`.cwd(project).quiet()
                  await $`git commit -m initial`.cwd(project).quiet()
                  await fs.writeFile(path.join(project, "staged.txt"), "staged\n")
                  await fs.writeFile(path.join(project, "force.txt"), "staged ignored file\n")
                  await $`git add staged.txt`.cwd(project).quiet()
                  await $`git add -f force.txt`.cwd(project).quiet()
                  if (split) await $`git update-index --split-index`.cwd(project).quiet()
                  await fs.writeFile(path.join(project, "tracked.txt"), "unstaged before\n")
                  await fs.writeFile(path.join(project, "ignored.txt"), "leave ignored\n")
                })
                const source = async () => {
                  const files = [
                    "tracked.txt",
                    "staged.txt",
                    "force.txt",
                    "ignored.txt",
                    ".gitignore",
                    ".git/index",
                    ...(await fs.readdir(path.join(project, ".git")))
                      .filter((name) => name.startsWith("sharedindex."))
                      .map((name) => `.git/${name}`),
                  ]
                  return {
                    files: await Promise.all(
                      files
                        .sort()
                        .map(async (file) => [file, (await fs.readFile(path.join(project, file))).toString("hex")]),
                    ),
                    refs: await $`git show-ref`.cwd(project).text(),
                  }
                }
                const original = yield* Effect.promise(source)
                yield* Effect.gen(function* () {
                  const snapshot = yield* Snapshot.Service
                  const captures = yield* Effect.all([snapshot.capture(), snapshot.capture()], { concurrency: 2 })
                  const before = captures[0]
                  expect(before).toBeDefined()
                  if (!before) throw new Error("Snapshot seed failed")
                  expect(captures[1]).toBe(before)
                  expect(yield* Effect.promise(source)).toEqual(original)
                  const projects = yield* Effect.promise(() => fs.readdir(path.join(data, "snapshot")))
                  const repository = path.join(data, "snapshot", projects[0], Hash.fast(project))
                  expect(
                    (yield* Effect.promise(() =>
                      $`git --git-dir ${repository} show ${`${before}:force.txt`}`.text(),
                    )).trim(),
                  ).toBe("staged ignored file")
                  expect(
                    (yield* Effect.promise(() => fs.readdir(repository))).filter((name) =>
                      name.startsWith("sharedindex."),
                    ),
                  ).toEqual([])
                  if (repair) {
                    yield* Effect.promise(() => fs.writeFile(path.join(repository, "index"), "broken historical index"))
                    const reopened = yield* Effect.acquireUseRelease(
                      Effect.sync(() =>
                        Bun.spawn(
                          [process.execPath, path.join(import.meta.dir, "fixture/snapshot-reopen.ts"), project, data],
                          {
                            stdout: "pipe",
                            stderr: "pipe",
                          },
                        ),
                      ),
                      (child) =>
                        Effect.promise(async () => {
                          const [code, stdout, stderr] = await Promise.all([
                            child.exited,
                            new Response(child.stdout).text(),
                            new Response(child.stderr).text(),
                          ])
                          expect(code, stderr).toBe(0)
                          return JSON.parse(stdout.trim()).id
                        }),
                      (child) =>
                        Effect.promise(async () => {
                          if (child.exitCode === null) child.kill()
                          await child.exited
                        }),
                    )
                    expect(reopened).toBe(before)
                    expect(yield* Effect.promise(source)).toEqual(original)
                  }
                  yield* Effect.promise(() => fs.writeFile(path.join(project, "tracked.txt"), "after\n"))
                  const changed = yield* Effect.promise(source)
                  const after = yield* snapshot.capture()
                  expect(after).toBeDefined()
                  if (!after) throw new Error("Snapshot capture failed")
                  expect(yield* Effect.promise(source)).toEqual(changed)
                  expect(yield* snapshot.files({ from: before, to: after })).toEqual([RelativePath.make("tracked.txt")])
                  yield* snapshot.restore({ files: new Map([[RelativePath.make("tracked.txt"), before]]) })
                  expect(yield* read(path.join(project, "tracked.txt"))).toBe("unstaged before\n")
                  expect(yield* Effect.promise(source)).toEqual(original)
                  expect(
                    (yield* Effect.promise(() => fs.readdir(repository))).filter((name) =>
                      name.startsWith("sharedindex."),
                    ),
                  ).toEqual([])
                }).pipe(Effect.provide(snapshotLayer(data, project)))
              }),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          ),
        20000,
      )

  testEffect(Layer.empty).live("captures and restores Location-scoped changes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          // Explicit multibyte characters test Git's byte limit independently of TEMP's spelling.
          const shared = path.join(tmp.path, "项目".repeat(16), "x".repeat(Math.max(1, 140 - tmp.path.length - 34)))
          const project = path.join(shared, "project")
          const location = path.join(project, "scope")
          yield* Effect.promise(async () => {
            await fs.mkdir(location, { recursive: true })
            await fs.writeFile(path.join(location, "tracked.txt"), "one\n")
            await fs.writeFile(path.join(project, "outside.txt"), "outside\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@zaovra.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          const data = path.join(shared, "data")
          const gitDirectory = path.join(data, "snapshot", "x".repeat(40), "x".repeat(40))
          expect(Buffer.byteLength(gitDirectory)).toBeGreaterThan(260)
          expect(gitDirectory.length).toBeLessThan(240)
          expect(path.relative(project, gitDirectory).length).toBeLessThan(120)
          const layer = snapshotLayer(data, location)
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return

            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(location, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(location, "added.txt"), "added\n")
              await fs.writeFile(path.join(project, "outside.txt"), "changed outside\n")
            })
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return

            expect(yield* snapshot.files({ from: before, to: after })).toEqual([
              RelativePath.make("scope/added.txt"),
              RelativePath.make("scope/tracked.txt"),
            ])
            const plan = new Map([[RelativePath.make("scope/tracked.txt"), before]])
            const preview = yield* snapshot.preview({ files: plan, context: 1 })
            expect(preview).toHaveLength(1)
            expect(preview[0]?.path).toBe(RelativePath.make("scope/tracked.txt"))
            yield* snapshot.restore({ files: plan })
            expect(yield* read(path.join(location, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(location, "added.txt"))).toBe("added\n")
            expect(yield* read(path.join(project, "outside.txt"))).toBe("changed outside\n")
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("reports unavailable snapshots beyond Windows character limits", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const shared = path.join(tmp.path, "x".repeat(Math.max(1, 180 - tmp.path.length - 1)))
          const project = path.join(shared, "project")
          const data = path.join(shared, "data")
          yield* Effect.promise(async () => {
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await $`git init`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@zaovra.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })
          const logs: Array<{ level: string; message: unknown }> = []
          const snapshot = yield* Effect.gen(function* () {
            const service = yield* Snapshot.Service
            return yield* service.capture()
          }).pipe(
            Effect.provide(snapshotLayer(data, project)),
            Effect.provide(
              Logger.layer([Logger.make((entry) => logs.push({ level: entry.logLevel, message: entry.message }))]),
            ),
          )
          const gitDirectory = path.join(data, "snapshot", "x".repeat(40), "x".repeat(40))
          expect(gitDirectory.length).toBeGreaterThan(260)
          expect(path.relative(project, gitDirectory).length).toBeLessThan(120)
          if (process.platform !== "win32") {
            expect(snapshot).toBeDefined()
            return
          }
          expect(snapshot).toBeUndefined()
          expect(logs).toContainEqual({
            level: "Warn",
            message: [
              "failed to capture snapshot",
              expect.objectContaining({
                reason: expect.any(String),
                absolutePathCharacters: gitDirectory.length,
                absolutePathBytes: Buffer.byteLength(gitDirectory),
                relativePathCharacters: path.relative(project, gitDirectory).length,
              }),
            ],
          })
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("treats capture outside Git as unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          expect(
            yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, tmp.path))),
          ).toBeUndefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("isolates snapshot indexes by canonical Git worktree", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const linked = path.join(tmp.path, "linked")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "main\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@zaovra.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
            await $`git worktree add --detach ${linked} HEAD`.cwd(project).quiet()
          })

          const capture = (directory: string) =>
            Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, directory)))
          expect(yield* capture(project)).toBeDefined()
          expect(yield* capture(linked)).toBeDefined()

          const projectID = yield* Effect.gen(function* () {
            return (yield* Location.Service).project.id
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))),
            ),
          )
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(project)))),
          ).toBeDefined()
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(linked)))),
          ).toBeDefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("checks out a legacy revert snapshot without removing unrelated files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@zaovra.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return
            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(project, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(project, "unrelated.txt"), "keep\n")
            })
            yield* snapshot.checkout(before)
            expect(yield* read(path.join(project, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(project, "unrelated.txt"))).toBe("keep\n")
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

function snapshotLayer(data: string, directory: string) {
  return AppNodeBuilder.build(Snapshot.node, [
    [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))],
    [Global.node, Global.layerWith({ data, config: path.join(data, "config") })],
  ])
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replaceAll("\r\n", "\n")))
}
