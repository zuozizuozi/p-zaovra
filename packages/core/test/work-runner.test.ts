import { $ } from "bun"
import { afterAll, describe, expect } from "bun:test"
import { DurableEventManifest } from "@zaovra-ai/schema/durable-event-manifest"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { Work } from "@zaovra-ai/core/work"
import { Database } from "@zaovra-ai/core/database/database"
import { EventV2 } from "@zaovra-ai/core/event"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { Git } from "@zaovra-ai/core/git"
import { Global } from "@zaovra-ai/core/global"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionInputTable, SessionMessageTable } from "@zaovra-ai/core/session/sql"
import { SessionProjector } from "@zaovra-ai/core/session/projector"
import { SessionStore } from "@zaovra-ai/core/session/store"
import { WorkExecution } from "@zaovra-ai/core/work/execution"
import { WorkArchitect } from "@zaovra-ai/core/work/architect"
import { WorkPlanner } from "@zaovra-ai/core/work/planner"
import { WorkProjector } from "@zaovra-ai/core/work/projector"
import { WorkReviewer } from "@zaovra-ai/core/work/reviewer"
import { WorkRemoteJob } from "@zaovra-ai/core/work/remote-job"
import { WorkRunner } from "@zaovra-ai/core/work/runner"
import { WorkGoalTable, WorkWorkerTable } from "@zaovra-ai/core/work/sql"
import { WorkStore } from "@zaovra-ai/core/work/store"
import { WorkVerifier } from "@zaovra-ai/core/work/verifier"
import { DateTime, Effect, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const reviewers = Layer.succeed(
  WorkReviewer.Service,
  WorkReviewer.Service.of({
    run: (input) =>
      Effect.succeed(
        Work.ReviewOutput.make({
          criteria: input.criteria.map((criterion) => ({
            criterionID: criterion.id,
            verdict: "pass",
            findings: [],
            allowsRepair: false,
          })),
        }),
      ),
  }),
)
const failingReviewers = Layer.succeed(
  WorkReviewer.Service,
  WorkReviewer.Service.of({
    run: (input) =>
      Effect.succeed(
        Work.ReviewOutput.make({
          criteria: input.criteria.map((criterion) => ({
            criterionID: criterion.id,
            verdict: "fail",
            findings: [{ code: "missing_test", message: "Missing boundary test", severity: "error" }],
            allowsRepair: true,
          })),
        }),
      ),
  }),
)
const nonRepairingReviewers = Layer.succeed(
  WorkReviewer.Service,
  WorkReviewer.Service.of({
    run: (input) =>
      Effect.succeed(
        Work.ReviewOutput.make({
          criteria: input.criteria.map((criterion) => ({
            criterionID: criterion.id,
            verdict: "fail",
            findings: [{ code: "manual_only", message: "Requires manual approval", severity: "error" }],
            allowsRepair: false,
          })),
        }),
      ),
  }),
)
const recoveryReviewers = Layer.succeed(
  WorkReviewer.Service,
  WorkReviewer.Service.of({
    run: (input) =>
      Effect.succeed(
        Work.ReviewOutput.make({
          criteria: input.criteria.map((criterion) => ({
            criterionID: criterion.id,
            verdict: input.task.title === "Implement the recovery plan" ? "pass" : "fail",
            findings:
              input.task.title === "Implement the recovery plan"
                ? []
                : [{ code: "stalled", message: "The original approach is still stalled", severity: "error" }],
            allowsRepair: input.task.title !== "Implement the recovery plan",
          })),
        }),
      ),
  }),
)
const planners = Layer.succeed(
  WorkPlanner.Service,
  WorkPlanner.Service.of({
    run: (input) =>
      Effect.succeed(
        Work.PlanOutput.make({
          tasks: [
            {
              key: "implementation",
              title: "Implement the Goal",
              instructions: input.goal.objective,
              dependsOn: [],
              role: "build",
              isolation: "shared",
              criteria: input.goal.acceptanceCriteria.map((criterion) => criterion.id),
            },
          ],
        }),
      ),
  }),
)
const architects = Layer.succeed(
  WorkArchitect.Service,
  WorkArchitect.Service.of({
    run: (input) => {
      const blocked = input.tasks.filter(
        (task) => task.status === "blocked" && task.role !== "work-architect" && task.role !== "work-planner",
      )
      return Effect.succeed(
        Work.ReplanOutput.make({
          supersedes: blocked.map((task) => task.id),
          tasks: [
            {
              key: "recovery",
              title: "Implement the recovery plan",
              instructions: "Address the recorded failure with a different implementation approach",
              dependsOn: [],
              role: "build",
              isolation: "shared",
              criteria: blocked.flatMap((task) => task.criteria),
            },
          ],
        }),
      )
    },
  }),
)
const runnerNodes = LayerNode.group([
  Database.node,
  EventV2.node,
  FSUtil.node,
  Git.node,
  SessionProjector.node,
  SessionStore.node,
  SessionV2.node,
  WorkProjector.node,
  WorkRemoteJob.node,
  WorkStore.node,
  Work.node,
  WorkRunner.node,
])
const artifactRoot = path.join(os.tmpdir(), `zaovra-work-runner-${process.pid}-${Date.now()}`)
afterAll(() => fs.rm(artifactRoot, { recursive: true, force: true }))
const runnerLayer = (
  reviewerLayer: Layer.Layer<WorkReviewer.Service>,
  executionLayer: Layer.Layer<SessionExecution.Service> = SessionExecution.noopLayer,
) =>
  AppNodeBuilder.build(runnerNodes, [
    [ProjectV2.node, projects],
    [Global.node, Global.layerWith({ data: artifactRoot })],
    [SessionExecution.node, executionLayer],
    [WorkExecution.node, WorkExecution.noopLayer],
    [WorkArchitect.node, architects],
    [WorkPlanner.node, planners],
    [WorkReviewer.node, reviewerLayer],
  ])
const it = testEffect(runnerLayer(reviewers))
const reviewIt = testEffect(runnerLayer(failingReviewers))
const nonRepairIt = testEffect(runnerLayer(nonRepairingReviewers))
const replanIt = testEffect(runnerLayer(recoveryReviewers))
const retryExecution = { calls: 0 }
const retryIt = testEffect(
  runnerLayer(
    reviewers,
    Layer.succeed(
      SessionExecution.Service,
      SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        resume: () =>
          Effect.sync(() => ++retryExecution.calls).pipe(
            Effect.flatMap((calls) => (calls < 3 ? Effect.die("temporary provider failure") : Effect.void)),
          ),
        wake: () => Effect.void,
        interrupt: () => Effect.void,
      }),
    ),
  ),
)
const concurrency = { active: 0, maximum: 0 }
const concurrencyIt = testEffect(
  runnerLayer(
    reviewers,
    Layer.succeed(
      SessionExecution.Service,
      SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        resume: () =>
          Effect.sync(() => {
            concurrency.active++
            concurrency.maximum = Math.max(concurrency.maximum, concurrency.active)
          }).pipe(
            Effect.andThen(Effect.sleep("50 millis")),
            Effect.ensuring(
              Effect.sync(() => {
                concurrency.active--
              }),
            ),
          ),
        wake: () => Effect.void,
        interrupt: () => Effect.void,
      }),
    ),
  ),
)
const goalID = Work.GoalID.make("goal_runner")

describe("WorkRunner", () => {
  it.effect("runs a durable Planner Attempt before executing its validated graph", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const created = yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Implement the planned feature",
        planning: true,
        acceptanceCriteria: [{ description: "Feature is complete", required: true, evidence: "review" }],
      })

      yield* runner.run({ goalID, force: true })

      const tasks = yield* work.tasks(goalID)
      expect(yield* work.get(goalID)).toMatchObject({ status: "completed", usage: { attempts: 3 } })
      expect(tasks).toHaveLength(2)
      expect(tasks.find((task) => task.role === "work-planner")).toMatchObject({
        id: created.tasks[0]?.id,
        status: "completed",
      })
      expect(tasks.find((task) => task.role === "build")).toMatchObject({ status: "completed" })
      expect(yield* store.attempts(created.tasks[0].id)).toMatchObject([{ kind: "plan", status: "succeeded" }])
    }),
  )

  it.effect("resumes a blocked Goal after credentials or subscription are repaired", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const events = yield* EventV2.Service
      const taskID = Work.TaskID.make("task_resume_after_auth")
      yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Continue after authentication is repaired",
        acceptanceCriteria: [{ description: "Task completes", required: true, evidence: "review" }],
        tasks: [{ id: taskID, title: "Resume implementation", instructions: "Continue the durable task" }],
      })
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: DateTime.makeUnsafe(2) })
      yield* events.publish(Work.Event.TaskReadied, {
        goalID,
        taskID,
        status: "ready",
        timestamp: DateTime.makeUnsafe(3),
      })
      yield* events.publish(Work.Event.TaskStarted, {
        goalID,
        taskID,
        status: "running",
        timestamp: DateTime.makeUnsafe(4),
      })
      yield* events.publish(Work.Event.TaskBlocked, {
        goalID,
        taskID,
        status: "blocked",
        reason: "SubscriptionRequiredError",
        timestamp: DateTime.makeUnsafe(5),
      })
      yield* events.publish(Work.Event.GoalBlocked, {
        goalID,
        reason: "SubscriptionRequiredError",
        timestamp: DateTime.makeUnsafe(6),
      })

      yield* runner.run({ goalID, force: true })

      expect(yield* work.get(goalID)).toMatchObject({ status: "completed" })
      expect((yield* work.tasks(goalID)).find((task) => task.id === taskID)).toMatchObject({ status: "completed" })
    }),
  )

  it.effect("runs an independent Architect Attempt and replaces a blocked Task with a durable recovery DAG", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const events = yield* EventV2.Service
      const store = yield* WorkStore.Service
      const blockedID = Work.TaskID.make("task_architect_blocked")
      yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Recover a blocked implementation",
        acceptanceCriteria: [{ description: "Recovery is complete", required: true, evidence: "review" }],
        budget: { maxReplans: 1 },
        tasks: [{ id: blockedID, title: "Failed implementation", instructions: "Original approach" }],
      })
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: DateTime.makeUnsafe(2) })
      yield* events.publish(Work.Event.TaskReadied, {
        goalID,
        taskID: blockedID,
        status: "ready",
        timestamp: DateTime.makeUnsafe(3),
      })
      yield* events.publish(Work.Event.TaskStarted, {
        goalID,
        taskID: blockedID,
        status: "running",
        timestamp: DateTime.makeUnsafe(4),
      })
      yield* events.publish(Work.Event.TaskBlocked, {
        goalID,
        taskID: blockedID,
        status: "blocked",
        reason: "Original approach made no progress",
        timestamp: DateTime.makeUnsafe(5),
      })
      yield* events.publish(Work.Event.GoalBlocked, {
        goalID,
        reason: "Original approach made no progress",
        timestamp: DateTime.makeUnsafe(6),
      })
      const architectTask = yield* work.requestReplan({
        goalID,
        taskID: Work.TaskID.make("task_architect_replan"),
        reason: "Use failure evidence to choose a different implementation",
      })

      yield* runner.run({ goalID, force: false })

      const tasks = yield* work.tasks(goalID)
      expect(yield* work.get(goalID)).toMatchObject({ status: "completed", usage: { attempts: 3 } })
      expect(tasks.find((task) => task.id === blockedID)).toMatchObject({ status: "superseded" })
      expect(tasks.find((task) => task.id === architectTask.id)).toMatchObject({
        status: "completed",
        role: "work-architect",
      })
      expect(tasks.find((task) => task.title === "Implement the recovery plan")).toMatchObject({
        status: "completed",
        role: "build",
      })
      expect(yield* store.attempts(architectTask.id)).toMatchObject([{ kind: "replan", status: "succeeded" }])
    }),
  )

  it.effect("finishes an Architect Task after restart when its replacement graph was already committed", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const events = yield* EventV2.Service
      const store = yield* WorkStore.Service
      const blockedID = Work.TaskID.make("task_replan_crash_blocked")
      const replacementID = Work.TaskID.make("task_replan_crash_replacement")
      yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Recover a committed replan",
        acceptanceCriteria: [{ description: "Recovery is complete", required: true, evidence: "review" }],
        tasks: [{ id: blockedID, title: "Blocked", instructions: "Blocked implementation" }],
      })
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: DateTime.makeUnsafe(2) })
      yield* events.publish(Work.Event.TaskReadied, {
        goalID,
        taskID: blockedID,
        status: "ready",
        timestamp: DateTime.makeUnsafe(3),
      })
      yield* events.publish(Work.Event.TaskStarted, {
        goalID,
        taskID: blockedID,
        status: "running",
        timestamp: DateTime.makeUnsafe(4),
      })
      yield* events.publish(Work.Event.TaskBlocked, {
        goalID,
        taskID: blockedID,
        status: "blocked",
        reason: "Blocked before replan",
        timestamp: DateTime.makeUnsafe(5),
      })
      const architectTask = yield* work.requestReplan({
        goalID,
        taskID: Work.TaskID.make("task_replan_crash_architect"),
        reason: "Recover after graph commit",
      })
      yield* events.publish(Work.Event.TaskReadied, {
        goalID,
        taskID: architectTask.id,
        status: "ready",
        timestamp: DateTime.makeUnsafe(6),
      })
      yield* events.publish(Work.Event.TaskStarted, {
        goalID,
        taskID: architectTask.id,
        status: "running",
        timestamp: DateTime.makeUnsafe(7),
      })
      const runningArchitect = yield* store.getTask(architectTask.id)
      if (!runningArchitect) return yield* Effect.die("Architect Task projection missing")
      const attemptID = Work.AttemptID.make("attempt_replan_crash")
      yield* events.publish(Work.Event.AttemptAdmitted, {
        goalID,
        timestamp: DateTime.makeUnsafe(8),
        info: Work.AttemptInfo.make({
          id: attemptID,
          goalID,
          taskID: architectTask.id,
          kind: "replan",
          number: 1,
          status: "admitted",
          inputRevision: runningArchitect.revision,
          time: { created: DateTime.makeUnsafe(8) },
        }),
      })
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID,
        attemptID,
        ownerID: "owner-before-crash",
        fence: 1,
        timestamp: DateTime.makeUnsafe(9),
      })
      yield* events.publish(Work.Event.AttemptSettled, {
        goalID,
        attemptID,
        ownerID: "owner-before-crash",
        fence: 1,
        status: "succeeded",
        timestamp: DateTime.makeUnsafe(10),
      })
      const criterionID = (yield* work.get(goalID)).acceptanceCriteria[0].id
      yield* events.publish(Work.Event.TaskGraphReplanned, {
        goalID,
        architectTaskID: architectTask.id,
        supersededTaskIDs: [blockedID],
        timestamp: DateTime.makeUnsafe(11),
        tasks: [
          Work.TaskInfo.make({
            id: replacementID,
            goalID,
            title: "Committed recovery",
            instructions: "Complete the committed recovery",
            dependsOn: [blockedID],
            role: "build",
            status: "pending",
            criteria: [criterionID],
            attemptCount: 0,
            time: { created: DateTime.makeUnsafe(11), updated: DateTime.makeUnsafe(11) },
            revision: 0,
          }),
        ],
      })

      yield* runner.run({ goalID, force: false })

      expect(yield* work.get(goalID)).toMatchObject({ status: "completed", usage: { attempts: 3 } })
      expect(yield* store.getTask(architectTask.id)).toMatchObject({ status: "completed" })
      expect(yield* store.getTask(replacementID)).toMatchObject({ status: "completed" })
      return yield* Effect.void
    }),
  )

  replanIt.effect("automatically escalates a no-progress review loop to the bounded Architect", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Escape a stalled implementation strategy",
        acceptanceCriteria: [{ description: "The corrected strategy passes", required: true, evidence: "review" }],
        budget: { maxRepairAttempts: 3, maxReplans: 1 },
      })

      yield* runner.run({ goalID, force: true })

      const tasks = yield* work.tasks(goalID)
      expect(yield* work.get(goalID)).toMatchObject({ status: "completed", usage: { attempts: 7, repairs: 1 } })
      expect(tasks.find((task) => task.title === "Escape a stalled implementation strategy")).toMatchObject({
        status: "superseded",
      })
      expect(tasks.filter((task) => task.role === "work-architect")).toMatchObject([{ status: "completed" }])
      expect(tasks.find((task) => task.title === "Implement the recovery plan")).toMatchObject({
        status: "completed",
      })
    }),
  )

  concurrencyIt.live("runs independent isolated Tasks with bounded parallelism", () =>
    Effect.gen(function* () {
      concurrency.active = 0
      concurrency.maximum = 0
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const firstID = Work.TaskID.make("task_parallel_first")
      const secondID = Work.TaskID.make("task_parallel_second")
      yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Run independent Tasks",
        acceptanceCriteria: [],
        budget: { maxParallelTasks: 2 },
        tasks: [
          {
            id: firstID,
            title: "First",
            instructions: "First isolated Task",
            location: { directory: AbsolutePath.make("/isolated-first") },
          },
          {
            id: secondID,
            title: "Second",
            instructions: "Second isolated Task",
            location: { directory: AbsolutePath.make("/isolated-second") },
          },
        ],
      })

      yield* runner.run({ goalID, force: true })

      expect(concurrency.maximum).toBe(2)
      expect(yield* work.get(goalID)).toMatchObject({ status: "blocked", usage: { attempts: 2 } })
    }),
  )

  it.live("merges an isolated Task change set into the Goal workspace", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(async () => {
        await $`git init`.cwd(root.path).quiet()
        await $`git config core.fsmonitor false`.cwd(root.path).quiet()
        await $`git config commit.gpgsign false`.cwd(root.path).quiet()
        await $`git config user.email test@zaovra.test`.cwd(root.path).quiet()
        await $`git config user.name Test`.cwd(root.path).quiet()
        await fs.writeFile(path.join(root.path, "base.txt"), "base\n")
        await $`git add .`.cwd(root.path).quiet()
        await $`git commit -m initial`.cwd(root.path).quiet()
      })
      const destination = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const isolated = AbsolutePath.make(`${root.path}-work-runner-isolated`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(isolated, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const git = yield* Git.Service
      const repository = yield* git.repo
        .discover(destination)
        .pipe(Effect.flatMap((result) => (result ? Effect.succeed(result) : Effect.die("Repository not found"))))
      const isolatedRepository = yield* git.worktree.create({ repository, directory: isolated })
      const content = "isolated change\n".repeat(6_000)
      yield* Effect.promise(() => fs.writeFile(path.join(isolated, "feature.txt"), content))
      yield* Effect.addFinalizer(() =>
        git.worktree.remove({ repository: isolatedRepository, directory: isolated, force: true }).pipe(Effect.ignore),
      )
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const created = yield* work.create({
        id: goalID,
        location: { directory: destination },
        objective: "Merge isolated work",
        acceptanceCriteria: [],
        tasks: [
          {
            title: "Implement in isolation",
            instructions: "Create the feature",
            location: { directory: isolated },
          },
        ],
      })

      yield* runner.run({ goalID, force: true })

      expect(yield* work.get(goalID)).toMatchObject({ status: "completed" })
      expect(yield* work.tasks(goalID)).toMatchObject([{ id: created.tasks[0]?.id, status: "completed" }])
      const history = yield* EventV2.readAggregate((yield* Database.Service).db, {
        aggregateID: goalID,
        limit: 100,
        manifest: DurableEventManifest.WorkDurable,
      })
      const prepared = history.events.find((event) => event.type === Work.Event.TaskMergeStarted.type)
      if (!prepared || prepared.type !== Work.Event.TaskMergeStarted.type) throw new Error("Merge input event missing")
      expect(prepared.data.changes).toBeUndefined()
      expect(prepared.data.artifact).toMatchObject({ digest: prepared.data.digest, mediaType: "text/x-diff" })
      expect(
        (yield* Effect.promise(() => fs.readFile(path.join(destination, "feature.txt"), "utf8"))).replaceAll(
          "\r\n",
          "\n",
        ),
      ).toBe(content)
      expect(
        yield* Effect.promise(() =>
          fs.stat(isolated).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  )

  it.live("archives cancelled isolated work before removing its worktree", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(async () => {
        await $`git init`.cwd(root.path).quiet()
        await $`git config core.fsmonitor false`.cwd(root.path).quiet()
        await $`git config commit.gpgsign false`.cwd(root.path).quiet()
        await $`git config user.email test@zaovra.test`.cwd(root.path).quiet()
        await $`git config user.name Test`.cwd(root.path).quiet()
        await fs.writeFile(path.join(root.path, "base.txt"), "base\n")
        await $`git add .`.cwd(root.path).quiet()
        await $`git commit -m initial`.cwd(root.path).quiet()
      })
      const destination = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const isolated = AbsolutePath.make(`${root.path}-work-runner-cancelled`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(isolated, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const git = yield* Git.Service
      const repository = yield* git.repo
        .discover(destination)
        .pipe(Effect.flatMap((result) => (result ? Effect.succeed(result) : Effect.die("Repository not found"))))
      yield* git.worktree.create({ repository, directory: isolated })
      yield* Effect.promise(() => fs.writeFile(path.join(isolated, "unfinished.txt"), "recoverable work\n"))
      const work = yield* Work.Service
      yield* work.create({
        id: goalID,
        location: { directory: destination },
        objective: "Cancel isolated work safely",
        acceptanceCriteria: [],
        tasks: [
          {
            id: Work.TaskID.make("task_cancelled"),
            title: "Isolated",
            instructions: "Work",
            location: { directory: isolated },
          },
        ],
      })

      yield* work.cancel(goalID, "Test cancellation")

      expect(yield* work.get(goalID)).toMatchObject({ status: "cancelled" })
      expect(
        yield* Effect.promise(() =>
          fs.stat(isolated).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      const history = yield* EventV2.readAggregate((yield* Database.Service).db, {
        aggregateID: goalID,
        limit: 100,
        manifest: DurableEventManifest.WorkDurable,
      })
      const archived = history.events.find((event) => event.type === Work.Event.TaskIsolationArchived.type)
      expect(archived?.data).toMatchObject({ taskID: "task_cancelled", reason: "cancelled" })
    }),
  )

  it.effect("completes semantic criteria through an independent reviewer Session and Attempt", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const db = (yield* Database.Service).db
      const created = yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Implement the feature",
        acceptanceCriteria: [{ description: "Tests pass", required: true, evidence: "test" }],
      })

      yield* runner.run({ goalID, force: true })

      expect(yield* work.get(goalID)).toMatchObject({ status: "completed", usage: { attempts: 2 } })
      expect(yield* store.getTask(created.tasks[0].id)).toMatchObject({ status: "completed", attemptCount: 2 })
      const attempts = yield* store.attempts(created.tasks[0].id)
      expect(attempts).toMatchObject([
        { kind: "execute", status: "succeeded", number: 1 },
        { kind: "review", status: "succeeded", number: 2 },
      ])
      expect(new Set(attempts.map((attempt) => attempt.sessionID)).size).toBe(2)
      expect(yield* db.select().from(SessionInputTable).all().pipe(Effect.orDie)).toHaveLength(1)
      expect(yield* store.evidence(created.tasks[0].id)).toMatchObject([{ kind: "review" }])
      expect(yield* store.evaluations(created.tasks[0].id)).toMatchObject([{ verdict: "pass" }])
    }),
  )

  it.effect("does not create another Attempt after independent review completes", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const created = yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Implement the feature",
        acceptanceCriteria: [{ description: "Tests pass", required: true, evidence: "test" }],
      })

      yield* runner.run({ goalID, force: true })
      yield* runner.run({ goalID, force: false })

      expect(yield* store.attempts(created.tasks[0].id)).toHaveLength(2)
    }),
  )

  reviewIt.effect("runs execute, review, repair, and review before no-progress stops rework", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const created = yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Implement the feature",
        acceptanceCriteria: [{ description: "Boundary behavior is correct", required: true, evidence: "review" }],
      })

      yield* runner.run({ goalID, force: true })

      expect(yield* work.get(goalID)).toMatchObject({ status: "blocked", usage: { attempts: 4, repairs: 1 } })
      expect(yield* store.getTask(created.tasks[0].id)).toMatchObject({ status: "blocked", attemptCount: 4 })
      expect(yield* store.attempts(created.tasks[0].id)).toMatchObject([
        { kind: "execute", status: "succeeded" },
        { kind: "review", status: "succeeded" },
        { kind: "repair", status: "succeeded" },
        { kind: "review", status: "succeeded" },
      ])
      expect(
        (yield* store.evaluations(created.tasks[0].id)).filter((evaluation) => evaluation.verdict === "fail"),
      ).toHaveLength(2)
    }),
  )

  nonRepairIt.effect("blocks reviewer failures that explicitly forbid automatic repair", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const created = yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Require manual review",
        acceptanceCriteria: [{ description: "Manual approval is present", required: true, evidence: "review" }],
      })

      yield* runner.run({ goalID, force: true })

      expect(yield* work.get(goalID)).toMatchObject({ status: "blocked", usage: { attempts: 2, repairs: 0 } })
      expect(yield* store.getTask(created.tasks[0].id)).toMatchObject({ status: "blocked", attemptCount: 2 })
      expect(yield* store.attempts(created.tasks[0].id)).toMatchObject([
        { kind: "execute", status: "succeeded" },
        { kind: "review", status: "succeeded" },
      ])
    }),
  )

  retryIt.effect("retries retryable Session failures within the hard Attempt bound", () =>
    Effect.gen(function* () {
      retryExecution.calls = 0
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const created = yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Recover from a temporary provider failure",
        budget: { maxAttemptsPerTask: 5 },
        acceptanceCriteria: [{ description: "Work completes", required: true, evidence: "review" }],
      })

      yield* runner.run({ goalID, force: true })

      expect(retryExecution.calls).toBe(3)
      expect(yield* work.get(goalID)).toMatchObject({ status: "completed", usage: { attempts: 4 } })
      expect(yield* store.attempts(created.tasks[0].id)).toMatchObject([
        { kind: "execute", status: "failed", failure: { retryable: true } },
        { kind: "execute", status: "failed", failure: { retryable: true } },
        { kind: "execute", status: "succeeded" },
        { kind: "review", status: "succeeded" },
      ])
    }),
  )

  retryIt.effect("stops retryable Session failures at the hard Attempt bound", () =>
    Effect.gen(function* () {
      retryExecution.calls = 0
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const created = yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Bound repeated provider failures",
        budget: { maxAttemptsPerTask: 2 },
        acceptanceCriteria: [{ description: "Work completes", required: true, evidence: "review" }],
      })

      yield* runner.run({ goalID, force: true })

      expect(retryExecution.calls).toBe(2)
      expect(yield* work.get(goalID)).toMatchObject({ status: "budget_exhausted", usage: { attempts: 2 } })
      expect(yield* store.attempts(created.tasks[0].id)).toMatchObject([
        { kind: "execute", status: "failed", failure: { retryable: true } },
        { kind: "execute", status: "failed", failure: { retryable: true } },
      ])
    }),
  )

  it.live("enforces the Goal duration budget before admitting provider work", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const created = yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Respect the duration budget",
        budget: { maxDurationMs: 1 },
        acceptanceCriteria: [{ description: "Work completes", required: true, evidence: "review" }],
      })

      yield* Effect.sleep("5 millis")
      yield* runner.run({ goalID, force: true })

      expect(yield* work.get(goalID)).toMatchObject({ status: "budget_exhausted", usage: { attempts: 0 } })
      expect(yield* store.getTask(created.tasks[0].id)).toMatchObject({ status: "blocked", attemptCount: 0 })
    }),
  )

  it.effect("enforces the durable provider-turn budget before admitting more work", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const created = yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Respect the provider-turn budget",
        budget: { maxTurns: 1 },
        acceptanceCriteria: [{ description: "Work completes", required: true, evidence: "review" }],
      })
      yield* db
        .update(WorkGoalTable)
        .set({ usage: { attempts: 0, repairs: 0, turns: 1, cost: 0 } })
        .where(eq(WorkGoalTable.id, goalID))
        .run()
        .pipe(Effect.orDie)

      yield* runner.run({ goalID, force: true })

      expect(yield* work.get(goalID)).toMatchObject({ status: "budget_exhausted", usage: { turns: 1 } })
      expect(yield* store.getTask(created.tasks[0].id)).toMatchObject({ status: "blocked", attemptCount: 0 })
    }),
  )

  it.effect("enforces the durable cost budget before admitting more work", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const created = yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Respect the cost budget",
        budget: { maxCost: 0.5 },
        acceptanceCriteria: [{ description: "Work completes", required: true, evidence: "review" }],
      })
      yield* db
        .update(WorkGoalTable)
        .set({ usage: { attempts: 0, repairs: 0, turns: 0, cost: 0.5 } })
        .where(eq(WorkGoalTable.id, goalID))
        .run()
        .pipe(Effect.orDie)

      yield* runner.run({ goalID, force: true })

      expect(yield* work.get(goalID)).toMatchObject({ status: "budget_exhausted", usage: { cost: 0.5 } })
      expect(yield* store.getTask(created.tasks[0].id)).toMatchObject({ status: "blocked", attemptCount: 0 })
    }),
  )

  it.effect("blocks the Goal instead of fabricating a Handoff when Session messages cannot be decoded", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const sessions = yield* SessionV2.Service
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const created = yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Preserve Handoff integrity",
        acceptanceCriteria: [],
      })
      const taskID = created.tasks[0].id
      const sessionID = SessionV2.ID.make("ses_corrupt_handoff")
      yield* sessions.create({ id: sessionID, location: created.goal.location, agent: AgentV2.ID.make("build") })
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: DateTime.makeUnsafe(2) })
      yield* events.publish(Work.Event.TaskReadied, {
        goalID,
        taskID,
        status: "ready",
        timestamp: DateTime.makeUnsafe(3),
      })
      yield* events.publish(Work.Event.TaskStarted, {
        goalID,
        taskID,
        status: "running",
        timestamp: DateTime.makeUnsafe(4),
      })
      const task = yield* store
        .getTask(taskID)
        .pipe(Effect.flatMap((value) => (value ? Effect.succeed(value) : Effect.die("Task projection missing"))))
      const attemptID = Work.AttemptID.make("attempt_corrupt_handoff")
      yield* events.publish(Work.Event.AttemptAdmitted, {
        goalID,
        timestamp: DateTime.makeUnsafe(5),
        info: Work.AttemptInfo.make({
          id: attemptID,
          goalID,
          taskID,
          kind: "execute",
          number: 1,
          sessionID,
          status: "admitted",
          inputRevision: task.revision,
          time: { created: DateTime.makeUnsafe(5) },
        }),
      })
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID,
        attemptID,
        ownerID: "runtime-1",
        fence: 1,
        timestamp: DateTime.makeUnsafe(6),
      })
      const corruptMessage: typeof SessionMessageTable.$inferInsert = {
        id: SessionMessage.ID.make("msg_corrupt_handoff"),
        session_id: sessionID,
        type: "assistant",
        seq: 1,
        data: { time: { created: 1 } },
      }
      yield* db
        .insert(SessionMessageTable)
        .values(corruptMessage)
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(Work.Event.AttemptSettled, {
        goalID,
        attemptID,
        status: "succeeded",
        ownerID: "runtime-1",
        fence: 1,
        timestamp: DateTime.makeUnsafe(7),
      })
      yield* events.publish(Work.Event.TaskVerificationStarted, {
        goalID,
        taskID,
        status: "verifying",
        timestamp: DateTime.makeUnsafe(8),
      })
      yield* events.publish(Work.Event.TaskCompleted, {
        goalID,
        taskID,
        status: "completed",
        timestamp: DateTime.makeUnsafe(9),
      })

      yield* runner.run({ goalID, force: false })

      expect(yield* work.get(goalID)).toMatchObject({ status: "blocked" })
      expect(yield* store.getTask(taskID)).toMatchObject({ status: "completed" })
      expect(yield* store.handoff(taskID)).toBeUndefined()
    }),
  )

  it.live("completes only after the runtime records passing command evidence", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const directory = AbsolutePath.make(yield* fs.makeTempDirectoryScoped())
      const created = yield* work.create({
        id: goalID,
        location: { directory },
        objective: "Implement the feature",
        acceptanceCriteria: [
          {
            description: "Tests pass",
            required: true,
            evidence: "test",
            verifier: { type: "command", command: 'bun -e "process.exit(0)"' },
          },
        ],
      })

      yield* runner.run({ goalID, force: true })

      expect(yield* work.get(goalID)).toMatchObject({ status: "completed", usage: { attempts: 2 } })
      expect(yield* store.getTask(created.tasks[0].id)).toMatchObject({ status: "completed" })
      expect(yield* store.evidence(created.tasks[0].id)).toMatchObject([
        { kind: "test", payload: { type: "command", exitCode: 0 } },
        { kind: "review" },
      ])
      expect(yield* store.evaluations(created.tasks[0].id)).toMatchObject([
        { verdict: "pass", findings: [] },
        { verdict: "pass", findings: [] },
      ])
    }),
  )

  it.live("stops after the same verifier failure signature makes no progress", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const directory = AbsolutePath.make(yield* fs.makeTempDirectoryScoped())
      const created = yield* work.create({
        id: goalID,
        location: { directory },
        objective: "Implement the feature",
        budget: { maxRepairAttempts: 3 },
        acceptanceCriteria: [
          {
            description: "Tests pass",
            required: true,
            evidence: "test",
            verifier: { type: "command", command: 'bun -e "process.exit(7)"' },
          },
        ],
      })

      yield* runner.run({ goalID, force: true })

      expect(yield* work.get(goalID)).toMatchObject({ status: "blocked", usage: { attempts: 2, repairs: 1 } })
      expect(yield* store.getTask(created.tasks[0].id)).toMatchObject({ status: "blocked", attemptCount: 2 })
      expect(yield* store.evidence(created.tasks[0].id)).toHaveLength(2)
      expect(yield* store.evaluations(created.tasks[0].id)).toMatchObject([
        { verdict: "fail", findings: [{ code: "unexpected_exit" }] },
        { verdict: "fail", findings: [{ code: "unexpected_exit" }] },
      ])

      yield* runner.run({ goalID, force: true })
      expect(yield* work.get(goalID)).toMatchObject({ status: "blocked", usage: { attempts: 2 } })
      expect(yield* store.attempts(created.tasks[0].id)).toHaveLength(2)
    }),
  )

  it.live("exhausts the explicit Attempt budget without accepting a failed verifier", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const directory = AbsolutePath.make(yield* fs.makeTempDirectoryScoped())
      const created = yield* work.create({
        id: goalID,
        location: { directory },
        objective: "Implement the feature",
        budget: { maxAttemptsPerTask: 1 },
        acceptanceCriteria: [
          {
            description: "Tests pass",
            required: true,
            evidence: "test",
            verifier: { type: "command", command: 'bun -e "process.exit(7)"' },
          },
        ],
      })

      yield* runner.run({ goalID, force: true })

      expect(yield* work.get(goalID)).toMatchObject({ status: "budget_exhausted", usage: { attempts: 1 } })
      expect(yield* store.getTask(created.tasks[0].id)).toMatchObject({ status: "blocked", attemptCount: 1 })
      expect(yield* store.evaluations(created.tasks[0].id)).toMatchObject([{ verdict: "fail" }])
    }),
  )

  it.live("settles a remote Agent Attempt and applies its verified cumulative patch", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(async () => {
        await $`git init`.cwd(root.path).quiet()
        await $`git config core.fsmonitor false`.cwd(root.path).quiet()
        await $`git config commit.gpgsign false`.cwd(root.path).quiet()
        await $`git config user.email test@zaovra.test`.cwd(root.path).quiet()
        await $`git config user.name Test`.cwd(root.path).quiet()
        await fs.writeFile(path.join(root.path, "base.txt"), "base\n")
        await $`git add .`.cwd(root.path).quiet()
        await $`git commit -m initial`.cwd(root.path).quiet()
      })
      const directory = AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root.path)))
      const git = yield* Git.Service
      const repository = yield* git.repo
        .discover(directory)
        .pipe(Effect.flatMap((result) => (result ? Effect.succeed(result) : Effect.die("Repository not found"))))
      yield* Effect.promise(() => fs.writeFile(path.join(directory, "remote-agent.txt"), "remote Agent output\n"))
      const changes = yield* git.change.capture({ repository, path: directory })
      yield* git.change.discard({ repository, path: directory, index: "reset", untracked: "remove" })
      const workerID = Work.WorkerID.make("worker_runner_remote_agent")
      yield* (yield* Database.Service).db
        .insert(WorkWorkerTable)
        .values({
          id: workerID,
          runtime_id: Work.WorkerRuntimeID.make("worker_runtime_runner_remote"),
          capacity: 1,
          label: "Remote Agent Worker",
          capabilities: ["execute", "mcp"],
          workspace_roots: [directory],
          execution_mode: "remote",
          location_mappings: [{ controllerRoot: directory, workerRoot: directory }],
          time_created: Date.now(),
          time_heartbeat: Date.now(),
          expires_at: Date.now() + 60_000,
        })
        .run()
        .pipe(Effect.orDie)
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const jobs = yield* WorkRemoteJob.Service
      const store = yield* WorkStore.Service
      const criterionID = Work.CriterionID.make("criterion_remote_agent_review")
      const created = yield* work.create({
        id: goalID,
        workerID,
        location: { directory },
        objective: "Apply remote Agent work",
        acceptanceCriteria: [
          { id: criterionID, description: "Remote implementation is correct", required: true, evidence: "review" },
        ],
        tasks: [
          {
            title: "Remote implementation",
            instructions: "Create remote-agent.txt",
            role: "developer",
            criteria: [criterionID],
          },
        ],
      })
      const run = yield* runner.run({ goalID, force: true }).pipe(Effect.forkChild)
      const assignment = yield* Effect.gen(function* () {
        while (true) {
          const claimed = (yield* jobs.claim({
            workerID,
            runtimeID: Work.WorkerRuntimeID.make("worker_runtime_runner_remote"),
            capacity: 1,
            recoverableJobIDs: [],
          })).jobs[0]
          if (claimed) return claimed
          yield* Effect.sleep(10)
        }
      })
      expect(assignment.operation).toMatchObject({ type: "agent", agent: "work-developer" })
      const digest = Work.ArtifactDigest.make(new Bun.CryptoHasher("sha256").update(changes).digest("hex"))
      const artifact = yield* jobs.uploadArtifact({
        workerID,
        jobID: assignment.id,
        fence: assignment.fence,
        label: "workspace.patch",
        digest,
        size: Buffer.byteLength(changes),
        content: changes,
      })
      const response =
        'Implemented remotely. <work-handoff>{"summary":"Remote implementation complete","items":[{"kind":"result","text":"Created remote-agent.txt","memory":"task"}]}</work-handoff>'
      expect(
        yield* jobs.complete({
          workerID,
          jobID: assignment.id,
          fence: assignment.fence,
          result: Work.WorkerAgentResult.make({
            type: "agent",
            sessionID:
              assignment.operation.type === "agent" ? assignment.operation.sessionID : SessionV2.ID.make("ses_invalid"),
            status: "succeeded",
            finalResponse: response,
            responseDigest: Work.ArtifactDigest.make(new Bun.CryptoHasher("sha256").update(response).digest("hex")),
            outputTruncated: false,
            stepCount: 2,
            toolCallCount: 1,
            baseRevision:
              assignment.operation.type === "agent" ? assignment.operation.artifactCapture.baseRevision : undefined,
            workspaceDigest: digest,
            artifacts: [artifact!],
          }),
        }),
      ).toBeTrue()
      const reviewAssignment = yield* Effect.gen(function* () {
        while (true) {
          const claimed = (yield* jobs.claim({
            workerID,
            runtimeID: Work.WorkerRuntimeID.make("worker_runtime_runner_remote"),
            capacity: 1,
            recoverableJobIDs: [],
          })).jobs[0]
          if (claimed) return claimed
          yield* Effect.sleep(10)
        }
      })
      expect(reviewAssignment.operation).toMatchObject({
        type: "agent",
        agent: "review",
        artifactCapture: { startDigest: digest },
      })
      const reviewArtifact = yield* jobs.uploadArtifact({
        workerID,
        jobID: reviewAssignment.id,
        fence: reviewAssignment.fence,
        label: "workspace.patch",
        digest,
        size: Buffer.byteLength(changes),
        content: changes,
      })
      const reviewResponse = JSON.stringify({
        criteria: [{ criterionID, verdict: "pass", findings: [], allowsRepair: false }],
      })
      expect(
        yield* jobs.complete({
          workerID,
          jobID: reviewAssignment.id,
          fence: reviewAssignment.fence,
          result: Work.WorkerAgentResult.make({
            type: "agent",
            sessionID:
              reviewAssignment.operation.type === "agent"
                ? reviewAssignment.operation.sessionID
                : SessionV2.ID.make("ses_invalid"),
            status: "succeeded",
            finalResponse: reviewResponse,
            responseDigest: Work.ArtifactDigest.make(
              new Bun.CryptoHasher("sha256").update(reviewResponse).digest("hex"),
            ),
            outputTruncated: false,
            stepCount: 1,
            toolCallCount: 0,
            baseRevision:
              reviewAssignment.operation.type === "agent"
                ? reviewAssignment.operation.artifactCapture.baseRevision
                : undefined,
            workspaceDigest: digest,
            artifacts: [reviewArtifact!],
          }),
        }),
      ).toBeTrue()
      yield* Fiber.join(run)

      expect(yield* work.get(goalID)).toMatchObject({ status: "completed", usage: { attempts: 2 } })
      expect(yield* store.getTask(created.tasks[0].id)).toMatchObject({ status: "completed" })
      expect(yield* store.handoff(created.tasks[0].id)).toMatchObject({ summary: "Remote implementation complete" })
      expect(
        (yield* Effect.promise(() => fs.readFile(path.join(directory, "remote-agent.txt"), "utf8"))).replaceAll(
          "\r\n",
          "\n",
        ),
      ).toBe("remote Agent output\n")
      expect((yield* jobs.list(goalID)).filter((job) => job.operation.type === "agent")).toHaveLength(2)
    }),
  )

  it.effect("rebuilds Evaluation from durable Evidence without rerunning a verifier after restart", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const runner = yield* WorkRunner.Service
      const store = yield* WorkStore.Service
      const events = yield* EventV2.Service
      const created = yield* work.create({
        id: goalID,
        location: { directory: AbsolutePath.make("/project") },
        objective: "Implement the feature",
        acceptanceCriteria: [
          {
            description: "Tests pass",
            required: true,
            evidence: "test",
            verifier: { type: "command", command: "this-command-must-not-run" },
          },
        ],
      })
      const timestamp = yield* DateTime.now
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp })
      yield* events.publish(Work.Event.TaskReadied, {
        goalID,
        taskID: created.tasks[0].id,
        status: "ready",
        timestamp,
      })
      yield* events.publish(Work.Event.TaskStarted, {
        goalID,
        taskID: created.tasks[0].id,
        status: "running",
        timestamp,
      })
      const task = yield* store.getTask(created.tasks[0].id)
      if (!task) return yield* Effect.die("Task projection missing")
      const attemptID = Work.AttemptID.make("attempt_evidence_recovery")
      yield* events.publish(Work.Event.AttemptAdmitted, {
        goalID,
        timestamp,
        info: Work.AttemptInfo.make({
          id: attemptID,
          goalID,
          taskID: task.id,
          kind: "execute",
          number: 1,
          status: "admitted",
          inputRevision: task.revision,
          time: { created: timestamp },
        }),
      })
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID,
        attemptID,
        ownerID: "recovery-test",
        fence: 1,
        timestamp,
      })
      yield* events.publish(Work.Event.AttemptSettled, {
        goalID,
        attemptID,
        status: "succeeded",
        ownerID: "recovery-test",
        fence: 1,
        timestamp,
      })
      yield* events.publish(Work.Event.TaskVerificationStarted, {
        goalID,
        taskID: task.id,
        status: "verifying",
        timestamp,
      })
      const goal = yield* store.getGoal(goalID)
      const attempt = yield* store.getAttempt(attemptID)
      if (!goal || !attempt) return yield* Effect.die("Work projection missing")
      const criterion = goal.acceptanceCriteria[0]
      yield* events.publish(Work.Event.EvidenceRecorded, {
        goalID,
        timestamp,
        info: Work.EvidenceInfo.make({
          id: WorkVerifier.id({ goal, task, attempt, criterion }),
          goalID,
          taskID: task.id,
          attemptID,
          criterionIDs: [criterion.id],
          kind: "test",
          producer: "work-verifier/command",
          payload: { type: "command", command: "recorded", exitCode: 0, output: "", outputTruncated: false },
          createdAt: timestamp,
        }),
      })

      yield* runner.run({ goalID, force: false })

      expect(yield* work.get(goalID)).toMatchObject({ status: "completed" })
      expect((yield* store.evidence(task.id)).map((evidence) => evidence.producer).sort()).toEqual([
        "work-reviewer/1",
        "work-verifier/command",
      ])
      const evaluations = yield* store.evaluations(task.id)
      expect(evaluations.map((evaluation) => evaluation.evaluator).sort()).toEqual(["work-reviewer", "work-verifier"])
      expect(evaluations.every((evaluation) => evaluation.verdict === "pass")).toBe(true)
      return yield* Effect.void
    }),
  )
})
