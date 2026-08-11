import { describe, expect } from "bun:test"
import { Work } from "@zaovra-ai/schema/work"
import { DateTime, Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { Database } from "@zaovra-ai/core/database/database"
import { EventV2 } from "@zaovra-ai/core/event"
import { EventTable } from "@zaovra-ai/core/event/sql"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@zaovra-ai/core/session/sql"
import { WorkProjector } from "@zaovra-ai/core/work/projector"
import { WorkHandoff } from "@zaovra-ai/core/work/handoff"
import { WorkStore } from "@zaovra-ai/core/work/store"
import { WorkAttemptTable } from "@zaovra-ai/core/work/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, WorkProjector.node, WorkStore.node])),
)
const location = { directory: AbsolutePath.make("/project") }
const goalID = Work.GoalID.make("goal_test")
const taskID = Work.TaskID.make("task_test")
const attemptID = Work.AttemptID.make("attempt_test")
const criterionID = Work.CriterionID.make("criterion_test")

function timestamp(value: number) {
  return DateTime.makeUnsafe(value)
}

function goalInfo() {
  return Work.GoalInfo.make({
    id: goalID,
    location,
    objective: "Implement durable work",
    acceptanceCriteria: [
      {
        id: criterionID,
        description: "Tests pass",
        required: true,
        evidence: "test",
      },
    ],
    status: "draft",
    usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
    time: { created: timestamp(1), updated: timestamp(1) },
    revision: 0,
  })
}

function taskInfo(
  input: { id?: Work.TaskID; dependsOn?: Work.TaskID[]; role?: string; criteria?: Work.CriterionID[] } = {},
) {
  return Work.TaskInfo.make({
    id: input.id ?? taskID,
    goalID,
    title: "Implement",
    instructions: "Implement and verify",
    dependsOn: input.dependsOn ?? [],
    role: input.role ?? "build",
    status: "pending",
    criteria: input.criteria ?? [criterionID],
    attemptCount: 0,
    time: { created: timestamp(2), updated: timestamp(2) },
    revision: 0,
  })
}

function recordProjectMemory(events: EventV2.Interface, store: WorkStore.Interface) {
  return Effect.gen(function* () {
    yield* events.publish(Work.Event.GoalCreated, { goalID, timestamp: timestamp(1), info: goalInfo() })
    yield* events.publish(Work.Event.TaskCreated, { goalID, timestamp: timestamp(2), info: taskInfo() })
    yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: timestamp(3) })
    yield* events.publish(Work.Event.TaskReadied, { goalID, taskID, status: "ready", timestamp: timestamp(4) })
    yield* events.publish(Work.Event.TaskStarted, { goalID, taskID, status: "running", timestamp: timestamp(5) })
    const task = yield* store.getTask(taskID)
    if (!task) return yield* Effect.die("Task projection missing")
    yield* events.publish(Work.Event.AttemptAdmitted, {
      goalID,
      timestamp: timestamp(6),
      info: Work.AttemptInfo.make({
        id: attemptID,
        goalID,
        taskID,
        kind: "execute",
        number: 1,
        status: "admitted",
        inputRevision: task.revision,
        time: { created: timestamp(6) },
      }),
    })
    yield* events.publish(Work.Event.AttemptStarted, {
      goalID,
      attemptID,
      ownerID: "runtime-1",
      fence: 1,
      timestamp: timestamp(7),
    })
    yield* events.publish(Work.Event.AttemptSettled, {
      goalID,
      attemptID,
      status: "succeeded",
      ownerID: "runtime-1",
      fence: 1,
      timestamp: timestamp(8),
    })
    yield* events.publish(Work.Event.TaskVerificationStarted, {
      goalID,
      taskID,
      status: "verifying",
      timestamp: timestamp(9),
    })
    yield* events.publish(Work.Event.TaskReviewStarted, {
      goalID,
      taskID,
      status: "reviewing",
      timestamp: timestamp(10),
    })
    yield* events.publish(Work.Event.TaskCompleted, {
      goalID,
      taskID,
      status: "completed",
      timestamp: timestamp(11),
    })
    const output = Work.HandoffOutput.make({
      summary: "Architecture decision recorded",
      items: [
        {
          kind: "decision",
          text: "Keep durable admission separate from execution",
          memory: "project",
          key: "session.admission",
        },
      ],
    })
    const handoff = Work.HandoffInfo.make({
      id: WorkHandoff.id(taskID),
      goalID,
      taskID,
      attemptID,
      producer: "build",
      summary: output.summary,
      items: output.items,
      evidenceIDs: [],
      recipients: [],
      digest: WorkHandoff.digest(output, []),
      createdAt: timestamp(12),
    })
    yield* events.publish(Work.Event.TaskHandoffRecorded, { goalID, timestamp: timestamp(12), info: handoff })
    return { handoff, item: output.items[0]! }
  })
}

describe("WorkProjector", () => {
  it.effect("accounts durable provider turns and cost when an Attempt settles", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const store = yield* WorkStore.Service
      const sessionID = SessionV2.ID.make("ses_work_usage")
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "work-usage",
          directory: location.directory,
          title: "Work usage",
          version: "test",
          cost: 1.25,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values(
          [1, 2].map((seq) => ({
            id: SessionMessage.ID.make(`msg_work_usage_${seq}`),
            session_id: sessionID,
            type: "assistant" as const,
            seq,
            time_created: seq,
            time_updated: seq,
            data: {
              agent: "build",
              model: { providerID: "test", id: "model" },
              content: [],
              cost: seq === 2 ? 1.25 : 0,
              time: { created: seq, completed: seq },
            },
          })),
        )
        .run()
        .pipe(Effect.orDie)
      yield* events.publish(Work.Event.GoalCreated, { goalID, timestamp: timestamp(1), info: goalInfo() })
      yield* events.publish(Work.Event.TaskCreated, { goalID, timestamp: timestamp(2), info: taskInfo() })
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: timestamp(3) })
      yield* events.publish(Work.Event.TaskReadied, { goalID, taskID, status: "ready", timestamp: timestamp(4) })
      yield* events.publish(Work.Event.TaskStarted, { goalID, taskID, status: "running", timestamp: timestamp(5) })
      const task = yield* store
        .getTask(taskID)
        .pipe(Effect.flatMap((value) => (value ? Effect.succeed(value) : Effect.die("Task projection missing"))))
      yield* events.publish(Work.Event.AttemptAdmitted, {
        goalID,
        timestamp: timestamp(6),
        info: Work.AttemptInfo.make({
          id: attemptID,
          goalID,
          taskID,
          kind: "execute",
          number: 1,
          sessionID,
          status: "admitted",
          inputRevision: task.revision,
          time: { created: timestamp(6) },
        }),
      })
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID,
        attemptID,
        ownerID: "runtime-1",
        fence: 1,
        timestamp: timestamp(7),
      })
      yield* events.publish(Work.Event.AttemptSettled, {
        goalID,
        attemptID,
        status: "succeeded",
        ownerID: "runtime-1",
        fence: 1,
        timestamp: timestamp(8),
      })

      expect(yield* store.getGoal(goalID)).toMatchObject({ usage: { attempts: 1, turns: 2, cost: 1.25 } })
    }),
  )

  it.effect("projects one complete execute, evidence, evaluation, and completion lifecycle", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkStore.Service

      yield* events.publish(Work.Event.GoalCreated, { goalID, timestamp: timestamp(1), info: goalInfo() })
      yield* events.publish(Work.Event.TaskCreated, { goalID, timestamp: timestamp(2), info: taskInfo() })
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: timestamp(3) })
      yield* events.publish(Work.Event.TaskReadied, { goalID, taskID, status: "ready", timestamp: timestamp(4) })
      yield* events.publish(Work.Event.TaskStarted, { goalID, taskID, status: "running", timestamp: timestamp(5) })

      const task = yield* store.getTask(taskID)
      if (!task) return yield* Effect.die("Task projection missing")
      yield* events.publish(Work.Event.AttemptAdmitted, {
        goalID,
        timestamp: timestamp(6),
        info: Work.AttemptInfo.make({
          id: attemptID,
          goalID,
          taskID,
          kind: "execute",
          number: 1,
          status: "admitted",
          inputRevision: task.revision,
          time: { created: timestamp(6) },
        }),
      })
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID,
        attemptID,
        ownerID: "runtime-1",
        fence: 1,
        timestamp: timestamp(7),
      })
      yield* events.publish(Work.Event.AttemptSettled, {
        goalID,
        attemptID,
        status: "succeeded",
        ownerID: "runtime-1",
        fence: 1,
        timestamp: timestamp(8),
      })

      const evidenceID = Work.EvidenceID.make("evidence_test")
      yield* events.publish(Work.Event.EvidenceRecorded, {
        goalID,
        timestamp: timestamp(9),
        info: Work.EvidenceInfo.make({
          id: evidenceID,
          goalID,
          taskID,
          attemptID,
          criterionIDs: [criterionID],
          kind: "test",
          producer: "bun-test",
          payload: { command: "bun test", exitCode: 0 },
          createdAt: timestamp(9),
        }),
      })
      yield* events.publish(Work.Event.EvaluationRecorded, {
        goalID,
        timestamp: timestamp(10),
        info: Work.EvaluationInfo.make({
          id: Work.EvaluationID.make("evaluation_test"),
          goalID,
          taskID,
          attemptID,
          criterionID,
          evidenceIDs: [evidenceID],
          verdict: "pass",
          evaluator: "deterministic-test",
          evaluatorVersion: "1",
          findings: [],
          allowsRepair: false,
          createdAt: timestamp(10),
        }),
      })
      yield* events.publish(Work.Event.TaskVerificationStarted, {
        goalID,
        taskID,
        status: "verifying",
        timestamp: timestamp(11),
      })
      yield* events.publish(Work.Event.TaskReviewStarted, {
        goalID,
        taskID,
        status: "reviewing",
        timestamp: timestamp(12),
      })
      yield* events.publish(Work.Event.TaskCompleted, {
        goalID,
        taskID,
        status: "completed",
        timestamp: timestamp(13),
      })
      const handoff = Work.HandoffOutput.make({
        summary: "Implementation verified",
        items: [{ kind: "fact", text: "The durable lifecycle test passes" }],
      })
      yield* events.publish(Work.Event.TaskHandoffRecorded, {
        goalID,
        timestamp: timestamp(14),
        info: Work.HandoffInfo.make({
          id: WorkHandoff.id(taskID),
          goalID,
          taskID,
          attemptID,
          producer: "build",
          summary: handoff.summary,
          items: handoff.items,
          evidenceIDs: [evidenceID],
          recipients: [],
          digest: WorkHandoff.digest(handoff, [evidenceID]),
          createdAt: timestamp(14),
        }),
      })
      yield* events.publish(Work.Event.GoalCompleted, { goalID, timestamp: timestamp(15) })

      expect(yield* store.getGoal(goalID)).toMatchObject({
        status: "completed",
        usage: { attempts: 1, repairs: 0 },
        revision: 14,
      })
      expect(yield* store.getTask(taskID)).toMatchObject({ status: "completed", attemptCount: 1 })
      expect(yield* store.getAttempt(attemptID)).toMatchObject({
        status: "succeeded",
        ownerID: "runtime-1",
        fence: 1,
      })
      expect(yield* store.evidence(taskID)).toHaveLength(1)
      expect(yield* store.evaluations(taskID)).toMatchObject([{ verdict: "pass" }])
      expect(yield* store.handoff(taskID)).toMatchObject({ summary: "Implementation verified" })
      return yield* Effect.void
    }),
  )

  it.effect("durably routes a Handoff only into a direct downstream Task mailbox", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkStore.Service
      const recipientID = Work.TaskID.make("task_recipient")
      yield* events.publish(Work.Event.GoalCreated, { goalID, timestamp: timestamp(1), info: goalInfo() })
      yield* events.publish(Work.Event.TaskCreated, { goalID, timestamp: timestamp(2), info: taskInfo() })
      yield* events.publish(Work.Event.TaskCreated, {
        goalID,
        timestamp: timestamp(3),
        info: taskInfo({ id: recipientID, dependsOn: [taskID] }),
      })
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: timestamp(4) })
      yield* events.publish(Work.Event.TaskReadied, { goalID, taskID, status: "ready", timestamp: timestamp(5) })
      yield* events.publish(Work.Event.TaskStarted, { goalID, taskID, status: "running", timestamp: timestamp(6) })
      const task = yield* store.getTask(taskID)
      if (!task) return yield* Effect.die("Task projection missing")
      yield* events.publish(Work.Event.AttemptAdmitted, {
        goalID,
        timestamp: timestamp(7),
        info: Work.AttemptInfo.make({
          id: attemptID,
          goalID,
          taskID,
          kind: "execute",
          number: 1,
          status: "admitted",
          inputRevision: task.revision,
          time: { created: timestamp(7) },
        }),
      })
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID,
        attemptID,
        ownerID: "runtime-1",
        fence: 1,
        timestamp: timestamp(8),
      })
      yield* events.publish(Work.Event.AttemptSettled, {
        goalID,
        attemptID,
        status: "succeeded",
        ownerID: "runtime-1",
        fence: 1,
        timestamp: timestamp(9),
      })
      yield* events.publish(Work.Event.TaskVerificationStarted, {
        goalID,
        taskID,
        status: "verifying",
        timestamp: timestamp(10),
      })
      yield* events.publish(Work.Event.TaskReviewStarted, {
        goalID,
        taskID,
        status: "reviewing",
        timestamp: timestamp(11),
      })
      yield* events.publish(Work.Event.TaskCompleted, {
        goalID,
        taskID,
        status: "completed",
        timestamp: timestamp(12),
      })
      const output = Work.HandoffOutput.make({
        summary: "Ready for downstream",
        items: [{ kind: "result", text: "Done" }],
      })
      const handoffID = WorkHandoff.id(taskID)
      yield* events.publish(Work.Event.TaskHandoffRecorded, {
        goalID,
        timestamp: timestamp(13),
        info: Work.HandoffInfo.make({
          id: handoffID,
          goalID,
          taskID,
          attemptID,
          producer: "build",
          summary: output.summary,
          items: output.items,
          evidenceIDs: [],
          recipients: [],
          digest: WorkHandoff.digest(output, []),
          createdAt: timestamp(13),
        }),
      })

      expect(yield* store.mailbox(recipientID)).toEqual([])
      expect(
        Exit.isFailure(
          yield* events
            .publish(Work.Event.TaskReadied, {
              goalID,
              taskID: recipientID,
              status: "ready",
              timestamp: timestamp(14),
            })
            .pipe(Effect.exit),
        ),
      ).toBe(true)
      yield* events.publish(Work.Event.TaskHandoffRouted, {
        goalID,
        handoffID,
        recipientTaskIDs: [recipientID],
        timestamp: timestamp(15),
      })
      expect(yield* store.mailbox(recipientID)).toMatchObject([{ id: handoffID, recipients: [recipientID] }])
      yield* events.publish(Work.Event.TaskReadied, {
        goalID,
        taskID: recipientID,
        status: "ready",
        timestamp: timestamp(16),
      })
      expect(yield* store.getTask(recipientID)).toMatchObject({ status: "ready" })
      return yield* Effect.void
    }),
  )

  it.effect("projects an exact project-memory resolution and rejects content drift", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkStore.Service
      const recorded = yield* recordProjectMemory(events, store)
      const info = Work.MemoryResolutionInfo.make({
        id: Work.MemoryResolutionID.make("memory_resolution_test"),
        goalID,
        location,
        key: "session.admission",
        handoffID: recorded.handoff.id,
        handoffDigest: recorded.handoff.digest,
        itemDigest: WorkHandoff.itemDigest(recorded.item),
        action: "select",
        resolver: "user",
        reason: "This is the verified architectural constraint",
        createdAt: timestamp(13),
      })
      yield* events.publish(Work.Event.ProjectMemoryResolved, { goalID, timestamp: timestamp(13), info })

      expect(yield* store.projectMemoryResolutions(location)).toEqual([info])
      const invalid = yield* events
        .publish(Work.Event.ProjectMemoryResolved, {
          goalID,
          timestamp: timestamp(14),
          info: Work.MemoryResolutionInfo.make({
            ...info,
            id: Work.MemoryResolutionID.make("memory_resolution_invalid"),
            itemDigest: "f".repeat(64),
            createdAt: timestamp(14),
          }),
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(invalid)).toBe(true)
      expect(yield* store.projectMemoryResolutions(location)).toEqual([info])
    }),
  )

  it.effect("rolls back an illegal transition with its durable event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkStore.Service
      const db = (yield* Database.Service).db
      yield* events.publish(Work.Event.GoalCreated, { goalID, timestamp: timestamp(1), info: goalInfo() })

      const exit = yield* events
        .publish(Work.Event.GoalCompleted, { goalID, timestamp: timestamp(2) })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* store.getGoal(goalID)).toMatchObject({ status: "draft", revision: 0 })
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, goalID)).all().pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("does not ready a Task until all dependencies are complete", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkStore.Service
      const dependencyID = Work.TaskID.make("task_dependency")
      yield* events.publish(Work.Event.GoalCreated, { goalID, timestamp: timestamp(1), info: goalInfo() })
      yield* events.publish(Work.Event.TaskCreated, {
        goalID,
        timestamp: timestamp(2),
        info: taskInfo({ id: dependencyID }),
      })
      yield* events.publish(Work.Event.TaskCreated, {
        goalID,
        timestamp: timestamp(3),
        info: taskInfo({ dependsOn: [dependencyID] }),
      })

      const exit = yield* events
        .publish(Work.Event.TaskReadied, { goalID, taskID, status: "ready", timestamp: timestamp(4) })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* store.getTask(taskID)).toMatchObject({ status: "pending" })
    }),
  )

  it.effect("atomically activates an Architect Task and commits a replacement graph", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkStore.Service
      const architectID = Work.TaskID.make("task_architect")
      const replacementID = Work.TaskID.make("task_replacement")
      yield* events.publish(Work.Event.GoalCreated, { goalID, timestamp: timestamp(1), info: goalInfo() })
      yield* events.publish(Work.Event.TaskCreated, { goalID, timestamp: timestamp(2), info: taskInfo() })
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: timestamp(3) })
      yield* events.publish(Work.Event.TaskReadied, { goalID, taskID, status: "ready", timestamp: timestamp(4) })
      yield* events.publish(Work.Event.TaskStarted, { goalID, taskID, status: "running", timestamp: timestamp(5) })
      yield* events.publish(Work.Event.TaskBlocked, {
        goalID,
        taskID,
        status: "blocked",
        reason: "No progress",
        timestamp: timestamp(6),
      })
      yield* events.publish(Work.Event.GoalBlocked, { goalID, reason: "No progress", timestamp: timestamp(7) })
      yield* events.publish(Work.Event.GoalReplanRequested, {
        goalID,
        reason: "Use a different approach",
        timestamp: timestamp(8),
        info: Work.TaskInfo.make({
          id: architectID,
          goalID,
          title: "Architect recovery",
          instructions: "Use a different approach",
          dependsOn: [],
          role: "work-architect",
          status: "pending",
          criteria: [],
          attemptCount: 0,
          time: { created: timestamp(8), updated: timestamp(8) },
          revision: 0,
        }),
      })

      expect(yield* store.getGoal(goalID)).toMatchObject({ status: "active" })
      expect(yield* store.getTask(architectID)).toMatchObject({ status: "pending", role: "work-architect" })
      yield* events.publish(Work.Event.TaskReadied, {
        goalID,
        taskID: architectID,
        status: "ready",
        timestamp: timestamp(9),
      })
      yield* events.publish(Work.Event.TaskStarted, {
        goalID,
        taskID: architectID,
        status: "running",
        timestamp: timestamp(10),
      })
      const invalidID = Work.TaskID.make("task_invalid_replacement")
      const invalid = yield* events
        .publish(Work.Event.TaskGraphReplanned, {
          goalID,
          architectTaskID: architectID,
          supersededTaskIDs: [taskID],
          timestamp: timestamp(11),
          tasks: [taskInfo({ id: invalidID, criteria: [] })],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(invalid)).toBe(true)
      expect(yield* store.getTask(taskID)).toMatchObject({ status: "blocked" })
      expect(yield* store.getTask(architectID)).toMatchObject({ status: "running" })
      expect(yield* store.getTask(invalidID)).toBeUndefined()
      yield* events.publish(Work.Event.TaskGraphReplanned, {
        goalID,
        architectTaskID: architectID,
        supersededTaskIDs: [taskID],
        timestamp: timestamp(11),
        tasks: [taskInfo({ id: replacementID, dependsOn: [taskID] })],
      })

      expect(yield* store.getTask(taskID)).toMatchObject({ status: "superseded" })
      expect(yield* store.getTask(replacementID)).toMatchObject({ status: "pending", dependsOn: [taskID] })
      yield* events.publish(Work.Event.TaskReadied, {
        goalID,
        taskID: replacementID,
        status: "ready",
        timestamp: timestamp(12),
      })
      expect(yield* store.getTask(replacementID)).toMatchObject({ status: "ready" })
    }),
  )

  it.effect("rejects settlement from a stale owner fence", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkStore.Service
      const db = (yield* Database.Service).db
      yield* events.publish(Work.Event.GoalCreated, { goalID, timestamp: timestamp(1), info: goalInfo() })
      yield* events.publish(Work.Event.TaskCreated, { goalID, timestamp: timestamp(2), info: taskInfo() })
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: timestamp(3) })
      yield* events.publish(Work.Event.TaskReadied, { goalID, taskID, status: "ready", timestamp: timestamp(4) })
      yield* events.publish(Work.Event.TaskStarted, { goalID, taskID, status: "running", timestamp: timestamp(5) })
      const task = yield* store.getTask(taskID)
      if (!task) return yield* Effect.die("Task projection missing")
      yield* events.publish(Work.Event.AttemptAdmitted, {
        goalID,
        timestamp: timestamp(6),
        info: Work.AttemptInfo.make({
          id: attemptID,
          goalID,
          taskID,
          kind: "execute",
          number: 1,
          status: "admitted",
          inputRevision: task.revision,
          time: { created: timestamp(6) },
        }),
      })
      yield* events.publish(Work.Event.AttemptStarted, {
        goalID,
        attemptID,
        ownerID: "runtime-1",
        fence: 2,
        timestamp: timestamp(7),
      })

      const exit = yield* events
        .publish(Work.Event.AttemptSettled, {
          goalID,
          attemptID,
          status: "failed",
          ownerID: "runtime-old",
          fence: 1,
          failure: { kind: "error", message: "late", retryable: true },
          timestamp: timestamp(8),
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(
        yield* db.select().from(WorkAttemptTable).where(eq(WorkAttemptTable.id, attemptID)).get().pipe(Effect.orDie),
      ).toMatchObject({ status: "running", owner_id: "runtime-1", fence: 2 })
      return yield* Effect.void
    }),
  )

  it.effect("projects a validated Planner graph atomically", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkStore.Service
      const firstID = Work.TaskID.make("task_planned_first")
      const secondID = Work.TaskID.make("task_planned_second")
      yield* events.publish(Work.Event.GoalCreated, { goalID, timestamp: timestamp(1), info: goalInfo() })
      yield* events.publish(Work.Event.TaskCreated, {
        goalID,
        timestamp: timestamp(2),
        info: taskInfo({ role: "work-planner", criteria: [] }),
      })
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: timestamp(3) })
      yield* events.publish(Work.Event.TaskGraphPlanned, {
        goalID,
        plannerTaskID: taskID,
        timestamp: timestamp(4),
        tasks: [taskInfo({ id: firstID }), taskInfo({ id: secondID, dependsOn: [firstID] })],
      })

      expect(yield* store.tasks(goalID)).toMatchObject([
        { id: taskID, role: "work-planner" },
        { id: firstID, dependsOn: [] },
        { id: secondID, dependsOn: [firstID] },
      ])
    }),
  )

  it.effect("rolls back an invalid Planner graph without partial Tasks", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkStore.Service
      const firstID = Work.TaskID.make("task_planned_first")
      const secondID = Work.TaskID.make("task_planned_second")
      yield* events.publish(Work.Event.GoalCreated, { goalID, timestamp: timestamp(1), info: goalInfo() })
      yield* events.publish(Work.Event.TaskCreated, {
        goalID,
        timestamp: timestamp(2),
        info: taskInfo({ role: "work-planner", criteria: [] }),
      })
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: timestamp(3) })
      const exit = yield* events
        .publish(Work.Event.TaskGraphPlanned, {
          goalID,
          plannerTaskID: taskID,
          timestamp: timestamp(4),
          tasks: [taskInfo({ id: firstID, dependsOn: [secondID] }), taskInfo({ id: secondID, dependsOn: [firstID] })],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* store.tasks(goalID)).toMatchObject([{ id: taskID }])
    }),
  )

  it.effect("rolls back an invalid dynamic graph expansion without partial Tasks", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const store = yield* WorkStore.Service
      const firstID = Work.TaskID.make("task_expanded_first")
      const secondID = Work.TaskID.make("task_expanded_second")
      yield* events.publish(Work.Event.GoalCreated, { goalID, timestamp: timestamp(1), info: goalInfo() })
      yield* events.publish(Work.Event.TaskCreated, { goalID, timestamp: timestamp(2), info: taskInfo() })
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: timestamp(3) })

      const exit = yield* events
        .publish(Work.Event.TaskGraphExpanded, {
          goalID,
          timestamp: timestamp(4),
          tasks: [taskInfo({ id: firstID, dependsOn: [secondID] }), taskInfo({ id: secondID, dependsOn: [firstID] })],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* store.tasks(goalID)).toMatchObject([{ id: taskID }])
    }),
  )
})
