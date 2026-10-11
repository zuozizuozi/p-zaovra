import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Work } from "@zaovra-ai/core/work"
import { WorkRunner } from "@zaovra-ai/core/work/runner"
import { WorkPlanner } from "@zaovra-ai/core/work/planner"
import { WorkReviewer } from "@zaovra-ai/core/work/reviewer"
import { WorkExecution } from "@zaovra-ai/core/work/execution"
import { WorkStore } from "@zaovra-ai/core/work/store"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { Project } from "@zaovra-ai/core/project"
import { ProjectCopy } from "@zaovra-ai/core/project/copy"
import { ProjectDirectories } from "@zaovra-ai/core/project/directories"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { Global } from "@zaovra-ai/core/global"
import { AppProcess } from "@zaovra-ai/core/process"
import { Database } from "@zaovra-ai/core/database/database"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { DateTime } from "effect"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Project.node,
      SessionV2.node,
      Work.node,
      WorkRunner.node,
      WorkStore.node,
      ProjectCopy.node,
      ProjectDirectories.node,
      AppProcess.node,
      Database.node,
    ]),
    [
      [SessionExecution.node, SessionExecution.noopLayer],
      [WorkExecution.node, WorkExecution.noopLayer],
      [
        WorkPlanner.node,
        Layer.succeed(
          WorkPlanner.Service,
          WorkPlanner.Service.of({
            run: ({ goal }) =>
              Effect.succeed(
                Work.PlanOutput.make({
                  tasks: [
                    {
                      key: "build",
                      title: "Build",
                      instructions: "Inspect the fixture",
                      dependsOn: [],
                      role: "build",
                      isolation: "worktree",
                      criteria: goal.acceptanceCriteria.map((item) => item.id),
                    },
                  ],
                }),
              ),
          }),
        ),
      ],
      [
        WorkReviewer.node,
        Layer.succeed(
          WorkReviewer.Service,
          WorkReviewer.Service.of({
            run: ({ criteria, task, evidence }) =>
              Effect.sync(() => {
                if (task.acceptance?.scope === "final")
                  expect(evidence.some((item) => item.taskID !== task.id && item.producer === "git-host/1")).toBe(true)
                return Work.ReviewOutput.make({
                  criteria: criteria.map((item) => ({
                    criterionID: item.id,
                    verdict: "pass",
                    findings: [],
                    allowsRepair: false,
                  })),
                })
              }),
          }),
        ),
      ],
    ],
  ),
)

function workspace(git = true) {
  return Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    )
    const directory = AbsolutePath.make(path.join(root.path, "中文 Project"))
    yield* Effect.promise(async () => {
      await fs.mkdir(directory)
      if (!git) return
      await $`git init`.cwd(directory).quiet()
      await $`git config core.fsmonitor false`.cwd(directory).quiet()
      await $`git config user.email test@zaovra.test`.cwd(directory).quiet()
      await $`git config user.name Test`.cwd(directory).quiet()
      await $`git -c commit.gpgsign=false commit --allow-empty -m ${root.path}`.cwd(directory).quiet()
    })
    return { root, directory }
  })
}

describe("Work isolation admission", () => {
  it.live(
    "registers a legacy project on Goal admission and exposes real worktree Git observations",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* workspace()
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(directory, "tracked.txt"), "before\n")
          await $`git add tracked.txt`.cwd(directory).quiet()
          await $`git -c commit.gpgsign=false commit -m baseline`.cwd(directory).quiet()
        })
        const projects = yield* Project.Service
        const directories = yield* ProjectDirectories.Service
        const work = yield* Work.Service
        const runner = yield* WorkRunner.Service
        const store = yield* WorkStore.Service
        const proc = yield* AppProcess.Service
        const project = yield* projects.resolve(directory)
        const database = yield* Database.Service
        yield* database.db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        expect(yield* directories.list(project.id)).toEqual([])
        // No Session is created before Goal admission.
        const created = yield* work.create({
          location: { directory },
          objective: "Inspect",
          planning: true,
          acceptanceCriteria: [{ description: "Fixture inspected", required: true, evidence: "review" }],
        })
        expect(yield* directories.contains({ projectID: project.id, directory })).toBe(true)
        yield* runner.run({ goalID: created.goal.id, force: true })
        const task = (yield* work.tasks(created.goal.id)).find((item) => item.role === "build")!
        expect(task.isolationState).toEqual({ status: "isolated" })
        const attempts = yield* store.attempts(task.id)
        yield* Effect.promise(() => fs.writeFile(path.join(task.location!.directory, "new.txt"), "untracked"))
        yield* Effect.promise(() => fs.writeFile(path.join(task.location!.directory, "tracked.txt"), "after\n"))
        const evidence = yield* WorkReviewer.gitEvidence(
          { goal: created.goal, task, attempt: attempts[0]!, timestamp: yield* DateTime.now },
          proc,
        )
        expect(evidence).toMatchObject({
          kind: "diff",
          producer: "git-host/1",
          payload: {
            status: { exit: 0, output: " M tracked.txt\n?? new.txt\n" },
            diff: { exit: 0, output: "1\t1\ttracked.txt\n" },
            head: { exit: 0 },
          },
        })
      }),
    30000,
  )

  it.live(
    "registers a first V2 session before copy creation, preserving the ownership boundary",
    () =>
      Effect.gen(function* () {
        const { root, directory } = yield* workspace()
        const sessions = yield* SessionV2.Service
        const projects = yield* Project.Service
        const directories = yield* ProjectDirectories.Service
        const copies = yield* ProjectCopy.Service
        const resolved = yield* projects.resolve(directory)
        expect(yield* directories.list(resolved.id)).toEqual([])
        const short =
          process.platform === "win32"
            ? yield* Effect.promise(async () => {
                const process = Bun.spawn(
                  [
                    "powershell.exe",
                    "-NoProfile",
                    "-Command",
                    `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (New-Object -ComObject Scripting.FileSystemObject).GetFolder('${directory.replaceAll("'", "''")}').ShortPath`,
                  ],
                  {
                    stdout: "pipe",
                  },
                )
                const output = (await new Response(process.stdout).text()).trim()
                expect(await process.exited).toBe(0)
                return output || directory
              })
            : directory
        const variants = Array.from(
          new Set(
            process.platform === "win32"
              ? [directory, AbsolutePath.make(directory.toUpperCase()), AbsolutePath.make(short)]
              : [directory],
          ),
        )
        for (const source of variants) {
          yield* sessions.create({ location: { directory: source } })
          const created = yield* copies.create({
            projectID: resolved.id,
            strategy: ProjectCopy.StrategyID.make("git_worktree"),
            sourceDirectory: source,
            directory: AbsolutePath.make(root.path),
            name: `copy-${variants.indexOf(source)}`,
          })
          expect(yield* Effect.promise(() => fs.stat(created.directory).then((stat) => stat.isDirectory()))).toBe(true)
          yield* copies.remove({ projectID: resolved.id, directory: created.directory, force: true })
        }
        const other = yield* workspace()
        const rejected = yield* copies
          .create({
            projectID: resolved.id,
            strategy: ProjectCopy.StrategyID.make("git_worktree"),
            sourceDirectory: other.directory,
            directory: AbsolutePath.make(root.path),
            name: "foreign",
          })
          .pipe(Effect.flip)
        expect(rejected).toBeInstanceOf(ProjectCopy.SourceDirectoryNotFoundError)
      }),
    30000,
  )

  for (const reason of ["not_git", "dirty"] as const) {
    it.live(
      `persists visible shared isolation reason for ${reason}`,
      () =>
        Effect.gen(function* () {
          const { directory } = yield* workspace(reason !== "not_git")
          if (reason === "dirty")
            yield* Effect.promise(() => fs.writeFile(path.join(directory, "dirty.txt"), "uncommitted"))
          const work = yield* Work.Service
          const runner = yield* WorkRunner.Service
          const created = yield* work.create({
            location: { directory },
            objective: "Inspect",
            planning: true,
            acceptanceCriteria: [{ description: "Fixture inspected", required: true, evidence: "review" }],
          })
          yield* runner.run({ goalID: created.goal.id, force: true })
          const task = (yield* work.tasks(created.goal.id)).find((task) => task.role === "build")
          expect(task?.isolationState).toMatchObject({
            status: "shared",
            reason: reason === "not_git" ? "当前目录不是 Git 仓库" : "工作区有未提交改动",
          })
        }),
      30000,
    )
  }

  it.live(
    "blocks unexpected provisioning failure without an execution attempt and resumes after filesystem repair",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* workspace()
        const projects = yield* Project.Service
        const project = yield* projects.resolve(directory)
        const obstruction = path.join(Global.Path.data, "worktree", project.id)
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(obstruction), { recursive: true })
          await fs.writeFile(obstruction, "blocked")
        })
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(obstruction, { recursive: true, force: true })))
        const work = yield* Work.Service
        const runner = yield* WorkRunner.Service
        const store = yield* WorkStore.Service
        const created = yield* work.create({
          location: { directory },
          objective: "Inspect",
          planning: true,
          acceptanceCriteria: [{ description: "Fixture inspected", required: true, evidence: "review" }],
        })
        yield* runner.run({ goalID: created.goal.id, force: true })
        const task = (yield* work.tasks(created.goal.id)).find((task) => task.role === "build")!
        expect(task).toMatchObject({ status: "blocked", isolationState: { status: "blocked" }, attemptCount: 0 })
        expect(yield* store.attempts(task.id)).toEqual([])
        expect((yield* work.get(created.goal.id))?.status).toBe("blocked")
        yield* runner.run({ goalID: created.goal.id, force: true })
        expect(yield* store.attempts(task.id)).toEqual([])
        yield* Effect.promise(() => fs.unlink(obstruction))
        yield* runner.run({ goalID: created.goal.id, force: true })
        const resumed = (yield* work.tasks(created.goal.id)).find((item) => item.id === task.id)!
        expect(resumed.isolationState).toEqual({ status: "isolated" })
        expect(resumed.location?.directory).not.toBe(directory)
        expect(resumed.status).not.toBe("blocked")
        expect((yield* store.attempts(task.id)).length).toBeGreaterThan(0)
      }),
    30000,
  )
})
