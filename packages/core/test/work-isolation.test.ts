import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Work } from "@zaovra-ai/core/work"
import { WorkRunner } from "@zaovra-ai/core/work/runner"
import { WorkPlanner } from "@zaovra-ai/core/work/planner"
import { WorkReviewer } from "@zaovra-ai/core/work/reviewer"
import { WorkExecution } from "@zaovra-ai/core/work/execution"
import { WorkStore } from "@zaovra-ai/core/work/store"
import { WorkMergeReview } from "@zaovra-ai/core/work/merge-review"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { Project } from "@zaovra-ai/core/project"
import { ProjectCopy } from "@zaovra-ai/core/project/copy"
import { ProjectDirectories } from "@zaovra-ai/core/project/directories"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { Global } from "@zaovra-ai/core/global"
import { AppProcess } from "@zaovra-ai/core/process"
import { Database } from "@zaovra-ai/core/database/database"
import { EventV2 } from "@zaovra-ai/core/event"
import { EventTable } from "@zaovra-ai/core/event/sql"
import { WorkGoalTable, WorkTaskTable } from "@zaovra-ai/core/work/sql"
import { asc, eq } from "drizzle-orm"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { DateTime } from "effect"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const isolationTests = (taskCount = 1) =>
  testEffect(
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
        EventV2.node,
        WorkMergeReview.node,
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
                    tasks: Array.from({ length: taskCount }, (_, index) => ({
                      key: `build-${index}`,
                      title: "Build",
                      instructions: "Inspect the fixture",
                      dependsOn: index === 0 ? [] : [`build-${index - 1}`],
                      role: "build",
                      isolation: "worktree",
                      criteria: goal.acceptanceCriteria.map((item) => item.id),
                    })),
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
                    expect(evidence.some((item) => item.taskID !== task.id && item.producer === "git-host/1")).toBe(
                      true,
                    )
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
const it = isolationTests()

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
        expect((yield* store.attempts(task.id))[0].kind).toBe("execute")
        expect((yield* work.get(created.goal.id))?.usage.repairs).toBe(0)
      }),
    30000,
  )

  for (const count of [2, 3])
    for (const legacy of [false, true])
      for (const scenario of [
        { maximum: 1, missingHandoff: false },
        { maximum: 3, missingHandoff: false },
        { maximum: 3, missingHandoff: true },
      ]) {
        if (scenario.missingHandoff && (!legacy || count !== 2)) continue
        isolationTests(count).live(
          `readmits isolation failure chain ${count} at concurrency ${scenario.maximum} legacy=${legacy} missingHandoff=${scenario.missingHandoff}`,
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
              yield* Effect.addFinalizer(() =>
                Effect.promise(() => fs.rm(obstruction, { recursive: true, force: true })),
              )
              const work = yield* Work.Service
              const runner = yield* WorkRunner.Service
              const store = yield* WorkStore.Service
              const events = yield* EventV2.Service
              const db = (yield* Database.Service).db
              const created = yield* work.create({
                location: { directory },
                objective: "Inspect chain",
                planning: true,
                budget: { maxParallelTasks: scenario.maximum, maxRepairAttempts: 1 },
                acceptanceCriteria: [{ description: "Fixture inspected", required: true, evidence: "review" }],
              })
              yield* runner.run({ goalID: created.goal.id, force: true })
              const blocked = (yield* store.tasks(created.goal.id)).filter((task) => task.role === "build")
              expect(blocked).toHaveLength(count)
              expect(blocked.every((task) => task.status === "blocked" && task.attemptCount === 0)).toBe(true)
              yield* Effect.promise(() => fs.unlink(obstruction))
              if (legacy) {
                const copies = yield* ProjectCopy.Service
                yield* events.publish(Work.Event.GoalActivated, {
                  goalID: created.goal.id,
                  timestamp: DateTime.nowUnsafe(),
                })
                for (const task of blocked) {
                  const copy = yield* copies.create({
                    projectID: project.id,
                    strategy: ProjectCopy.StrategyID.make("git_worktree"),
                    sourceDirectory: directory,
                    directory: AbsolutePath.make(obstruction),
                    name: task.id,
                  })
                  yield* events.publish(Work.Event.TaskIsolationResolved, {
                    goalID: created.goal.id,
                    taskID: task.id,
                    isolation: { status: "isolated" },
                    location: { directory: copy.directory },
                    timestamp: DateTime.nowUnsafe(),
                  })
                  yield* events.publish(Work.Event.TaskReworkRequested, {
                    goalID: created.goal.id,
                    taskID: task.id,
                    status: "rework",
                    reason: "Isolation repaired after user intervention",
                    timestamp: DateTime.nowUnsafe(),
                  })
                }
                const history = yield* db
                  .select()
                  .from(EventTable)
                  .where(eq(EventTable.aggregate_id, created.goal.id))
                  .orderBy(asc(EventTable.seq))
                  .all()
                  .pipe(Effect.orDie)
                yield* db.delete(WorkGoalTable).where(eq(WorkGoalTable.id, created.goal.id)).run().pipe(Effect.orDie)
                yield* events.remove(created.goal.id)
                yield* events.replayAll(
                  history.map((row) => ({
                    id: row.id,
                    aggregateID: row.aggregate_id,
                    seq: row.seq,
                    type: row.type,
                    data: row.data,
                  })),
                )
                expect(
                  (yield* store.tasks(created.goal.id))
                    .filter((task) => task.role === "build")
                    .every((task) => task.status === "rework" && task.attemptCount === 0),
                ).toBe(true)
                if (scenario.missingHandoff) {
                  // Negative control: a completed upstream projection without any recoverable Handoff
                  // must not let the old downstream rework bypass first-admission dependencies.
                  const upstream = blocked.find((task) => task.dependsOn.length === 0)!
                  const downstream = blocked.find((task) => task.dependsOn.includes(upstream.id))!
                  yield* db
                    .update(WorkTaskTable)
                    .set({ status: "completed" })
                    .where(eq(WorkTaskTable.id, upstream.id))
                    .run()
                    .pipe(Effect.orDie)
                  yield* runner.run({ goalID: created.goal.id, force: true })
                  expect(yield* store.handoff(upstream.id)).toBeUndefined()
                  expect(yield* store.attempts(downstream.id)).toEqual([])
                  expect((yield* store.getGoal(created.goal.id))?.usage.repairs).toBe(0)
                  return
                }
              }
              const admitted: { kind: string; ready: boolean }[] = []
              const unsubscribe = yield* events.listen((event) =>
                Effect.gen(function* () {
                  if (!Schema.is(Work.Event.AttemptAdmitted)(event) || event.data.info.goalID !== created.goal.id)
                    return
                  const task = yield* store.getTask(event.data.info.taskID)
                  if (task?.role !== "build") return
                  const handoffs = yield* store.handoffs(created.goal.id)
                  const dependencies: boolean[] = []
                  for (const dependency of task.dependsOn) {
                    dependencies.push(
                      (yield* store.getTask(dependency))?.status === "completed" &&
                        handoffs.some(
                          (handoff) => handoff.taskID === dependency && handoff.recipients.includes(task.id),
                        ),
                    )
                  }
                  admitted.push({ kind: event.data.info.kind, ready: dependencies.every(Boolean) })
                }),
              )
              yield* Effect.addFinalizer(() => unsubscribe)
              yield* runner.run({ goalID: created.goal.id, force: true })
              const review = yield* WorkMergeReview.Service
              for (let index = 0; index < count; index++) {
                const current = (yield* store.tasks(created.goal.id)).filter((task) => task.role === "build")
                expect(current.filter((task) => task.status === "pending")).toHaveLength(count - index - 1)
                const merging = current.find((task) => task.status === "merging")!
                expect(merging).toBeDefined()
                const candidate = yield* review.read(created.goal.id, merging.id)
                yield* review.decide(created.goal.id, merging.id, candidate.token, true)
                yield* runner.run({ goalID: created.goal.id, force: true })
              }
              const tasks = yield* store.tasks(created.goal.id)
              const goal = yield* store.getGoal(created.goal.id)
              expect(tasks.filter((task) => task.role === "build").map((task) => task.status)).toEqual(
                Array(count).fill("completed"),
              )
              expect(goal?.usage.repairs).toBe(0)
              expect(admitted.filter((item) => item.kind !== "review")).toEqual(
                Array.from({ length: count }, () => ({ kind: "execute", ready: true })),
              )
              const history = yield* db
                .select()
                .from(EventTable)
                .where(eq(EventTable.aggregate_id, created.goal.id))
                .orderBy(asc(EventTable.seq))
                .all()
                .pipe(Effect.orDie)
              expect(history.filter((row) => row.type.startsWith(Work.Event.TaskReworkRequested.type))).toHaveLength(
                legacy ? count : 0,
              )
              yield* db.delete(WorkGoalTable).where(eq(WorkGoalTable.id, created.goal.id)).run().pipe(Effect.orDie)
              yield* events.remove(created.goal.id)
              yield* events.replayAll(
                history.map((row) => ({
                  id: row.id,
                  aggregateID: row.aggregate_id,
                  seq: row.seq,
                  type: row.type,
                  data: row.data,
                })),
              )
              expect(yield* store.tasks(created.goal.id)).toEqual(tasks)
              expect(yield* store.getGoal(created.goal.id)).toEqual(goal)
            }),
          60000,
        )
      }

  for (const legacy of [false, true, "paused"] as const) {
    it.live(
      `recovers a resolved isolation across a crash (legacy rework: ${legacy})`,
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
          const events = yield* EventV2.Service
          const db = (yield* Database.Service).db
          const created = yield* work.create({
            location: { directory },
            objective: "Inspect",
            planning: true,
            acceptanceCriteria: [{ description: "Fixture inspected", required: true, evidence: "review" }],
          })
          yield* runner.run({ goalID: created.goal.id, force: true })
          const task = (yield* store.tasks(created.goal.id)).find((task) => task.role === "build")!
          // The persisted boundary after provisioning, before the runner activates the Goal.
          yield* events.publish(Work.Event.TaskIsolationResolved, {
            goalID: created.goal.id,
            taskID: task.id,
            isolation: { status: "shared", reason: "dirty" },
            location: { directory },
            timestamp: DateTime.nowUnsafe(),
          })
          expect((yield* store.getTask(task.id))?.status).toBe("pending")
          if (legacy) {
            yield* events.publish(Work.Event.GoalActivated, {
              goalID: created.goal.id,
              timestamp: DateTime.nowUnsafe(),
            })
            yield* events.publish(Work.Event.TaskReworkRequested, {
              goalID: created.goal.id,
              taskID: task.id,
              status: "rework",
              reason: "Isolation repaired after user intervention",
              timestamp: DateTime.nowUnsafe(),
            })
          }
          if (legacy === "paused") yield* work.pause(created.goal.id)
          const tasks = yield* store.tasks(created.goal.id)
          const goal = yield* store.getGoal(created.goal.id)
          const history = yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.goal.id))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)
          yield* db.delete(WorkGoalTable).where(eq(WorkGoalTable.id, created.goal.id)).run().pipe(Effect.orDie)
          yield* events.remove(created.goal.id)
          yield* events.replayAll(
            history.map((row) => ({
              id: row.id,
              aggregateID: row.aggregate_id,
              seq: row.seq,
              type: row.type,
              data: row.data,
            })),
          )
          expect(yield* store.tasks(created.goal.id)).toEqual(tasks)
          expect(yield* store.getGoal(created.goal.id)).toEqual(goal)
          yield* runner.run({ goalID: created.goal.id, force: true })
          expect((yield* store.attempts(task.id))[0].kind).toBe("execute")
          expect((yield* store.getGoal(created.goal.id))?.usage.repairs).toBe(0)
        }),
      30000,
    )
  }
})
