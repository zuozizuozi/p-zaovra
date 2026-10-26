import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { CrossSpawnSpawner } from "@zaovra-ai/core/cross-spawn-spawner"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Git } from "../../src/git"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { disposeAllInstances, provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Worktree.node, FSUtil.node, Git.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, InstanceBootstrap.node],
  ]),
)
const wintest = process.platform !== "win32" ? it.instance : it.instance.skip

function normalize(input: string) {
  return input.replace(/\\/g, "/").toLowerCase()
}

const waitReady = Effect.fn("WorktreeTest.waitReady")(function* () {
  const ready = yield* Deferred.make<{ name: string; branch?: string }>()
  const on = (evt: GlobalEvent) => {
    if (evt.payload.type !== Worktree.Event.Ready.type) return
    Deferred.doneUnsafe(ready, Effect.succeed(evt.payload.properties))
  }

  GlobalBus.on("event", on)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

  return yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for worktree.ready")),
    }),
  )
})

const removeCreatedWorktree = (directory: string) =>
  Effect.gen(function* () {
    const svc = yield* Worktree.Service
    const ok = yield* svc.remove({ directory })
    if (!ok) return yield* Effect.fail(new Error(`failed to remove worktree ${directory}`))
  })

const withCreatedWorktree = <A, E, R>(
  input: Parameters<Worktree.Interface["create"]>[0],
  use: (created: { info: Worktree.Info; ready: { name: string; branch?: string } }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const svc = yield* Worktree.Service
      const ready = yield* waitReady().pipe(Effect.forkScoped)
      const info = yield* svc.create(input)
      const props = yield* Fiber.join(ready)
      return { info, ready: props }
    }),
    use,
    ({ info }) => removeCreatedWorktree(info.directory),
  )

const git = Effect.fn("WorktreeTest.git")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  const result = yield* service.run(args, { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text()
})

const gitResult = Effect.fn("WorktreeTest.gitResult")(function* (cwd: string, args: string[]) {
  const service = yield* Git.Service
  return yield* service.run(args, { cwd })
})

describe("Worktree", () => {
  afterEach(() => disposeAllInstances())

  describe("makeWorktreeInfo", () => {
    it.instance(
      "returns info with name, branch, and directory",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo()

          expect(info.name).toBeDefined()
          expect(typeof info.name).toBe("string")
          expect(info.branch).toBe(`zaovra/${info.name}`)
          expect(info.directory).toContain(info.name)
        }),
      { git: true },
    )

    it.instance(
      "uses provided name as base",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "my-feature" })

          expect(info.name).toBe("my-feature")
          expect(info.branch).toBe("zaovra/my-feature")
        }),
      { git: true },
    )

    it.instance(
      "slugifies the provided name",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "My Feature Branch!" })

          expect(info.name).toBe("my-feature-branch")
        }),
      { git: true },
    )

    it.instance(
      "omits branch for detached info",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          yield* git(test.directory, ["branch", "zaovra/my-feature"])

          const info = yield* svc.makeWorktreeInfo({ name: "my-feature", detached: true })

          expect(info.name).toBe("my-feature")
          expect(info.branch).toBeUndefined()
        }),
      { git: true },
    )

    it.instance("fails with NotGitError for non-git directories", () =>
      Effect.gen(function* () {
        const svc = yield* Worktree.Service
        const exit = yield* Effect.exit(svc.makeWorktreeInfo())

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.NotGitError)
          if (error instanceof Worktree.NotGitError) expect(error._tag).toBe("WorktreeNotGitError")
        }
      }),
    )

    wintest(
      "creates detached git worktree when info has no branch",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const info = yield* svc.makeWorktreeInfo({ name: "detached-test", detached: true })
          const ready = yield* waitReady().pipe(Effect.forkScoped)
          yield* svc.createFromInfo(info)

          const list = yield* git(test.directory, ["worktree", "list", "--porcelain"])
          const normalizedList = normalize(list)
          const normalizedDir = normalize(info.directory)
          expect(normalizedList).toContain(normalizedDir)

          const branch = yield* gitResult(info.directory, ["symbolic-ref", "-q", "--short", "HEAD"])
          expect(branch.exitCode).not.toBe(0)

          const props = yield* Fiber.join(ready)
          expect(props.name).toBe(info.name)
          expect(props.branch).toBeUndefined()

          yield* svc.remove({ directory: info.directory })
        }),
      { git: true },
    )
  })

  describe("create + remove lifecycle", () => {
    it.instance(
      "create returns worktree info and remove cleans up",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            expect(info.name).toBeDefined()
            expect(info.branch ?? "").toStartWith("zaovra/")
            expect(info.directory).toBeDefined()
          }),
        ),
      { git: true },
    )

    it.instance(
      "create returns after setup and fires Event.Ready after bootstrap",
      () =>
        withCreatedWorktree(undefined, ({ info, ready }) =>
          Effect.gen(function* () {
            const svc = yield* Worktree.Service

            expect(info.name).toBeDefined()
            expect(info.branch ?? "").toStartWith("zaovra/")

            expect(ready.name).toBe(info.name)
            expect(ready.branch).toBe(info.branch)

            const list = yield* svc.list()
            expect(list).toContainEqual(expect.objectContaining({ name: info.name, branch: info.branch }))
          }),
        ),
      { git: true },
    )

    it.instance(
      "lists the active linked worktree but not the project checkout",
      () =>
        withCreatedWorktree(undefined, ({ info }) =>
          Effect.gen(function* () {
            const test = yield* TestInstance
            const svc = yield* Worktree.Service
            const list = yield* svc.list().pipe(provideInstance(info.directory))

            expect(list.map((item) => item.name)).toContain(info.name)
            expect(list.map((item) => item.name)).not.toContain(path.basename(test.directory).toLowerCase())
          }),
        ),
      { git: true },
    )

    it.instance(
      "create with custom name",
      () =>
        withCreatedWorktree({ name: "test-workspace" }, ({ info }) =>
          Effect.gen(function* () {
            expect(info.name).toBe("test-workspace")
            expect(info.branch).toBe("zaovra/test-workspace")
          }),
        ),
      { git: true },
    )
  })

  describe("createFromInfo", () => {
    it.instance(
      "runs a normal startup command to completion after reporting readiness",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const finished = path.join(test.directory, "startup-finished")
          const script = path.join(test.directory, "startup.cjs")
          yield* Effect.promise(() =>
            Bun.write(script, `require("node:fs").writeFileSync(${JSON.stringify(finished)}, "done")`),
          )
          yield* git(test.directory, ["add", "startup.cjs"])
          yield* git(test.directory, ["commit", "-m", "startup fixture"])
          const info = yield* svc.makeWorktreeInfo({ name: "startup-completion" })
          yield* Effect.acquireUseRelease(
            svc.createFromInfo(info, "bun startup.cjs", true).pipe(Effect.as(info)),
            () =>
              pollWithTimeout(
                Effect.promise(async () => ((await Bun.file(finished).exists()) ? true : undefined)),
                "startup command did not complete",
              ),
            (created) => removeCreatedWorktree(created.directory).pipe(Effect.orDie),
          )
          expect(yield* Effect.promise(() => Bun.file(finished).text())).toBe("done")
        }),
      { git: true },
    )

    it.live("closing the Worktree service scope terminates its background startup process", () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped({ git: true })
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        // Build an independent service lifetime so this test closes the scope that owns the startup fiber.
        const services = yield* Layer.buildWithScope(
          Layer.fresh(
            LayerNode.compile(LayerNode.group([Worktree.node, InstanceStore.node]), [
              [InstanceStore.bootstrapNode, InstanceBootstrap.node],
            ]),
          ),
          scope,
        )
        const script = path.join(directory, "startup.cjs")
        const pidFile = path.join(directory, "startup-pid")
        yield* Effect.promise(() =>
          Bun.write(
            script,
            `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
            setInterval(() => {}, 1000); setTimeout(() => process.exit(2), 20000).unref();`,
          ),
        )
        const info = { name: "scope-cleanup", directory: path.join(directory, "linked") }
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => disposeAllInstances()).pipe(
            Effect.andThen(git(directory, ["worktree", "remove", "--force", info.directory])),
            Effect.orDie,
          ),
        )
        yield* Effect.gen(function* () {
          const svc = yield* Worktree.Service
          yield* svc
            .createFromInfo(info, "bun ../startup.cjs", true)
            .pipe(Effect.timeout("6 seconds"))
        }).pipe(provideInstance(directory), Effect.provide(services))
        const pid = Number(
          yield* pollWithTimeout(
            Effect.promise(async () => ((await Bun.file(pidFile).exists()) ? Bun.file(pidFile).text() : undefined)),
            "startup process never became ready",
          ),
        )
        expect(Number.isInteger(pid) && pid > 0).toBe(true)
        expect(() => process.kill(pid, 0)).not.toThrow()
        yield* Scope.close(scope, Exit.void)
        yield* pollWithTimeout(
          Effect.sync(() => {
            try {
              process.kill(pid, 0)
              return undefined
            } catch (error) {
              if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error
              return true
            }
          }),
          "background startup process survived service scope closure",
        )
      }),
    )

    it.instance(
      "a bootstrap failure still fails synchronous creation without publishing Ready",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          yield* Effect.promise(() => Bun.write(path.join(test.directory, "zaovra.json"), "{ invalid json"))
          yield* git(test.directory, ["add", "zaovra.json"])
          yield* git(test.directory, ["commit", "-m", "invalid bootstrap config"])
          const info = yield* svc.makeWorktreeInfo({ name: "bootstrap-failure" })
          const ready: string[] = []
          const on = (event: GlobalEvent) => {
            if (event.payload.type === Worktree.Event.Ready.type && event.directory) ready.push(event.directory)
          }
          GlobalBus.on("event", on)
          yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))
          yield* Effect.addFinalizer(() => removeCreatedWorktree(info.directory).pipe(Effect.ignore))
          const exit = yield* Effect.exit(svc.createFromInfo(info, undefined, true))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(ready).not.toContain(info.directory)
        }),
      { git: true },
    )

    ;(it.instance(
      "can wait for checkout and bootstrap before reporting creation",
      () =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const fs = yield* FSUtil.Service
          const info = yield* svc.makeWorktreeInfo({ name: "await-ready" })
          yield* Effect.acquireUseRelease(
            svc.createFromInfo(info, undefined, true).pipe(Effect.as(info)),
            (created) =>
              Effect.gen(function* () {
                expect(yield* fs.exists(path.join(created.directory, ".git"))).toBe(true)
                expect((yield* git(created.directory, ["status", "--porcelain"])).trim()).toBe("")
              }),
            (created) => removeCreatedWorktree(created.directory).pipe(Effect.orDie),
          )
        }),
      { git: true },
    ),
      wintest(
        "creates git worktree and boots asynchronously",
        () =>
          Effect.gen(function* () {
            const test = yield* TestInstance
            const svc = yield* Worktree.Service
            const info = yield* svc.makeWorktreeInfo({ name: "from-info-test" })
            const ready = yield* waitReady().pipe(Effect.forkScoped)
            yield* svc.createFromInfo(info)

            const list = yield* git(test.directory, ["worktree", "list", "--porcelain"])
            const normalizedList = list.replace(/\\/g, "/")
            const normalizedDir = info.directory.replace(/\\/g, "/")
            expect(normalizedList).toContain(normalizedDir)

            yield* Fiber.join(ready)
            yield* removeCreatedWorktree(info.directory)
          }),
        { git: true },
      ))
  })

  describe("list", () => {
    it.instance(
      "uses parent folder name when worktree basename matches the primary worktree",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const fs = yield* FSUtil.Service
          const svc = yield* Worktree.Service
          const parent = path.join(path.dirname(test.directory), `${path.basename(test.directory)}-parent`)
          const target = path.join(parent, path.basename(test.directory))
          const branch = `same-basename-list-${Date.now()}`

          yield* fs.ensureDir(parent)
          yield* git(test.directory, ["worktree", "add", "-b", branch, target])

          const list = yield* svc.list()
          const directory = yield* fs.realPath(target).pipe(Effect.catch(() => Effect.succeed(target)))

          expect(list.map((item) => ({ ...item, directory: normalize(item.directory) }))).toContainEqual({
            name: path.basename(parent),
            branch,
            directory: normalize(directory),
          })

          yield* svc.remove({ directory: target })
        }),
      { git: true },
    )
  })

  describe("remove edge cases", () => {
    it.instance(
      "remove non-existent directory succeeds silently",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const svc = yield* Worktree.Service
          const ok = yield* svc.remove({ directory: path.join(test.directory, "does-not-exist") })
          expect(ok).toBe(true)
        }),
      { git: true },
    )

    it.instance("fails with NotGitError for non-git directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const svc = yield* Worktree.Service
        const exit = yield* Effect.exit(svc.remove({ directory: path.join(test.directory, "fake") }))

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Worktree.NotGitError)
          if (error instanceof Worktree.NotGitError) expect(error._tag).toBe("WorktreeNotGitError")
        }
      }),
    )
  })
})
