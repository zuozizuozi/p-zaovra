import { describe, expect } from "bun:test"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { Work } from "@zaovra-ai/core/work"
import { WorkExecution } from "@zaovra-ai/core/work/execution"
import { WorkProjector } from "@zaovra-ai/core/work/projector"
import { WorkRecovery } from "@zaovra-ai/core/work/recovery"
import { WorkReviewer } from "@zaovra-ai/core/work/reviewer"
import { WorkStore } from "@zaovra-ai/core/work/store"
import { WorkWorkerJobTable } from "@zaovra-ai/core/work/sql"
import { WorkWorker } from "@zaovra-ai/core/work/worker"
import { DateTime, Effect } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, WorkProjector.node, WorkStore.node, Work.node, WorkRecovery.node]),
    [[WorkExecution.node, WorkExecution.noopLayer]],
  ),
)
const goalID = Work.GoalID.make("goal_recovery")
const attemptID = Work.AttemptID.make("attempt_recovery")

const setupAttempt = Effect.fn("setupAttempt")(function* () {
  const work = yield* Work.Service
  const events = yield* EventV2.Service
  const store = yield* WorkStore.Service
  const created = yield* work.create({
    id: goalID,
    location: { directory: AbsolutePath.make("/project") },
    objective: "Recover durable work",
    acceptanceCriteria: [{ description: "Tests pass", required: true, evidence: "test" }],
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
  return task.id
})

describe("WorkRecovery", () => {
  it.effect("wakes a durably admitted Attempt without replaying it inline", () =>
    Effect.gen(function* () {
      yield* setupAttempt()
      const recovery = yield* WorkRecovery.Service
      const store = yield* WorkStore.Service

      expect(yield* recovery.recover()).toEqual({
        woken: [goalID],
        paused: [],
        cancelled: [],
        recoveredAttempts: [],
        unknownAttempts: [],
      })
      expect(yield* store.getGoal(goalID)).toMatchObject({ status: "active" })
      expect(yield* store.getAttempt(attemptID)).toMatchObject({ status: "admitted" })
    }),
  )

  it.effect("marks a running Attempt unknown instead of replaying unknown side effects", () =>
    Effect.gen(function* () {
      const taskID = yield* setupAttempt()
      const events = yield* EventV2.Service
      const recovery = yield* WorkRecovery.Service
      const store = yield* WorkStore.Service
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID,
        attemptID,
        ownerID: "lost-process",
        fence: 1,
        timestamp: yield* DateTime.now,
      })

      expect(yield* recovery.recover()).toEqual({
        woken: [],
        paused: [],
        cancelled: [],
        recoveredAttempts: [],
        unknownAttempts: [attemptID],
      })
      expect(yield* store.getGoal(goalID)).toMatchObject({ status: "blocked" })
      expect(yield* store.getTask(taskID)).toMatchObject({ status: "blocked" })
      expect(yield* store.getAttempt(attemptID)).toMatchObject({
        status: "unknown",
        failure: { kind: "unknown", retryable: false },
      })
    }),
  )

  it.effect("settles a completed remote Agent result instead of losing it during controller failover", () =>
    Effect.gen(function* () {
      const taskID = yield* setupAttempt()
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const recovery = yield* WorkRecovery.Service
      const store = yield* WorkStore.Service
      const timestamp = yield* DateTime.now
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID,
        attemptID,
        ownerID: "failed-controller",
        fence: 1,
        timestamp,
      })
      yield* db
        .insert(WorkWorkerJobTable)
        .values({
          id: Work.WorkerJobID.make("worker_job_recovery_agent"),
          worker_id: WorkWorker.defaultID,
          goal_id: goalID,
          attempt_id: attemptID,
          criterion_id: Work.CriterionID.make("criterion_recovery_agent"),
          status: "completed",
          fence: 1,
          operation: {
            type: "agent",
            sessionID: SessionV2.ID.make("ses_recovery_agent"),
            agent: AgentV2.defaultID,
            prompt: "Recover the completed remote result",
            location: { directory: AbsolutePath.make("/project") },
            artifactCapture: { type: "git_diff", baseRevision: "0".repeat(40), maxBytes: 1_024 },
          },
          result: {
            type: "agent",
            sessionID: SessionV2.ID.make("ses_recovery_agent"),
            status: "succeeded",
            finalResponse: "Completed before the controller failed",
            outputTruncated: false,
            stepCount: 1,
            toolCallCount: 0,
          },
          time_created: DateTime.toEpochMillis(timestamp),
          time_updated: DateTime.toEpochMillis(timestamp),
          time_completed: DateTime.toEpochMillis(timestamp),
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* recovery.recover(goalID)).toMatchObject({
        woken: [goalID],
        recoveredAttempts: [attemptID],
        unknownAttempts: [],
      })
      expect(yield* store.getAttempt(attemptID)).toMatchObject({ status: "succeeded" })
      expect(yield* store.getTask(taskID)).toMatchObject({ status: "verifying" })
    }),
  )

  it.effect("requires explicit retry authorization before reworking an unknown Attempt", () =>
    Effect.gen(function* () {
      const taskID = yield* setupAttempt()
      const events = yield* EventV2.Service
      const recovery = yield* WorkRecovery.Service
      const store = yield* WorkStore.Service
      const work = yield* Work.Service
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID,
        attemptID,
        ownerID: "lost-process",
        fence: 1,
        timestamp: yield* DateTime.now,
      })
      yield* recovery.recover()

      yield* work.resolveUnknown(goalID, attemptID, "the user inspected the workspace")
      yield* work.resolveUnknown(goalID, attemptID, "exact retry")

      expect(yield* store.getGoal(goalID)).toMatchObject({ status: "active" })
      expect(yield* store.getTask(taskID)).toMatchObject({ status: "rework" })
      expect(yield* store.getAttempt(attemptID)).toMatchObject({ status: "unknown" })
    }),
  )

  it.effect("recovers a running review from its durable structured output", () =>
    Effect.gen(function* () {
      const taskID = yield* setupAttempt()
      const events = yield* EventV2.Service
      const recovery = yield* WorkRecovery.Service
      const store = yield* WorkStore.Service
      const task = yield* store.getTask(taskID)
      const goal = yield* store.getGoal(goalID)
      if (!task || !goal) return yield* Effect.die("Work projection missing")
      const timestamp = yield* DateTime.now
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID,
        attemptID,
        ownerID: "completed-executor",
        fence: 1,
        timestamp,
      })
      yield* events.publish(Work.Event.AttemptSettled, {
        goalID,
        attemptID,
        status: "succeeded",
        ownerID: "completed-executor",
        fence: 1,
        timestamp,
      })
      yield* events.publish(Work.Event.TaskVerificationStarted, {
        goalID,
        taskID,
        status: "verifying",
        timestamp,
      })
      yield* events.publish(Work.Event.TaskReviewStarted, {
        goalID,
        taskID,
        status: "reviewing",
        timestamp,
      })
      const reviewingTask = yield* store.getTask(taskID)
      if (!reviewingTask) return yield* Effect.die("Reviewing Task projection missing")
      const reviewAttemptID = Work.AttemptID.make("attempt_recovery_review")
      yield* events.publish(Work.Event.AttemptAdmitted, {
        goalID,
        timestamp,
        info: Work.AttemptInfo.make({
          id: reviewAttemptID,
          goalID,
          taskID,
          kind: "review",
          number: 2,
          status: "admitted",
          inputRevision: reviewingTask.revision,
          time: { created: timestamp },
        }),
      })
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID,
        attemptID: reviewAttemptID,
        ownerID: "lost-reviewer",
        fence: 2,
        timestamp,
      })
      const output = Work.ReviewOutput.make({
        criteria: [
          {
            criterionID: goal.acceptanceCriteria[0].id,
            verdict: "pass",
            findings: [],
            allowsRepair: false,
          },
        ],
      })
      const reviewEvidenceID = WorkReviewer.evidenceID(reviewAttemptID)
      yield* events.publish(Work.Event.EvidenceRecorded, {
        goalID,
        timestamp,
        info: Work.EvidenceInfo.make({
          id: reviewEvidenceID,
          goalID,
          taskID,
          attemptID: reviewAttemptID,
          criterionIDs: [goal.acceptanceCriteria[0].id],
          kind: "review",
          producer: "work-reviewer/1",
          payload: output,
          createdAt: timestamp,
        }),
      })

      expect(yield* recovery.recover()).toEqual({
        woken: [goalID],
        paused: [],
        cancelled: [],
        recoveredAttempts: [reviewAttemptID],
        unknownAttempts: [],
      })
      expect(yield* store.getAttempt(reviewAttemptID)).toMatchObject({ status: "succeeded" })
      expect(yield* store.evaluations(taskID)).toEqual([
        expect.objectContaining({
          attemptID: reviewAttemptID,
          criterionID: goal.acceptanceCriteria[0].id,
          verdict: "pass",
        }),
      ])
      return yield* Effect.void
    }),
  )

  it.effect("finishes a durable pause request without waking admitted work", () =>
    Effect.gen(function* () {
      yield* setupAttempt()
      const events = yield* EventV2.Service
      const recovery = yield* WorkRecovery.Service
      const store = yield* WorkStore.Service
      yield* events.publish(Work.Event.GoalPauseRequested, { goalID, timestamp: yield* DateTime.now })

      expect(yield* recovery.recover()).toEqual({
        woken: [],
        paused: [goalID],
        cancelled: [],
        recoveredAttempts: [],
        unknownAttempts: [],
      })
      expect(yield* store.getGoal(goalID)).toMatchObject({ status: "paused" })
      expect(yield* store.getAttempt(attemptID)).toMatchObject({ status: "admitted" })
    }),
  )

  it.effect("finishes a durable cancellation without starting admitted work", () =>
    Effect.gen(function* () {
      const taskID = yield* setupAttempt()
      const events = yield* EventV2.Service
      const recovery = yield* WorkRecovery.Service
      const store = yield* WorkStore.Service
      yield* events.publish(Work.Event.GoalCancelRequested, { goalID, timestamp: yield* DateTime.now })

      expect(yield* recovery.recover()).toEqual({
        woken: [],
        paused: [],
        cancelled: [goalID],
        recoveredAttempts: [],
        unknownAttempts: [],
      })
      expect(yield* store.getGoal(goalID)).toMatchObject({ status: "cancelled" })
      expect(yield* store.getTask(taskID)).toMatchObject({ status: "cancelled" })
      expect(yield* store.getAttempt(attemptID)).toMatchObject({ status: "cancelled" })
    }),
  )

  it.effect("preserves an unknown running outcome while finishing cancellation", () =>
    Effect.gen(function* () {
      const taskID = yield* setupAttempt()
      const events = yield* EventV2.Service
      const recovery = yield* WorkRecovery.Service
      const store = yield* WorkStore.Service
      const timestamp = yield* DateTime.now
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID,
        attemptID,
        ownerID: "lost-cancelling-process",
        fence: 1,
        timestamp,
      })
      yield* events.publish(Work.Event.GoalCancelRequested, { goalID, timestamp })

      expect(yield* recovery.recover()).toEqual({
        woken: [],
        paused: [],
        cancelled: [goalID],
        recoveredAttempts: [],
        unknownAttempts: [attemptID],
      })
      expect(yield* store.getGoal(goalID)).toMatchObject({ status: "cancelled" })
      expect(yield* store.getTask(taskID)).toMatchObject({ status: "cancelled" })
      expect(yield* store.getAttempt(attemptID)).toMatchObject({ status: "unknown" })
    }),
  )
})
