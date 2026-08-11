export * as WorkEvent from "./work-event"

import { Schema } from "effect"
import { Event } from "./event"
import { DateTimeUtcFromMillis, NonNegativeInt, optional } from "./schema"
import {
  ArtifactReference,
  AttemptInfo,
  AttemptStatus,
  EvaluationInfo,
  EvidenceInfo,
  Failure,
  GoalInfo,
  HandoffInfo,
  MemoryResolutionInfo,
  TaskInfo,
} from "./work-contract"
import { AttemptID, GoalID, HandoffID, TaskID, WorkerID } from "./work-id"

const options = {
  durable: {
    aggregate: "goalID",
    version: 1,
  },
} as const

const Base = {
  goalID: GoalID,
  timestamp: DateTimeUtcFromMillis,
}

export const GoalCreated = Event.define({
  type: "work.goal.created",
  ...options,
  schema: { ...Base, info: GoalInfo },
})
export type GoalCreated = typeof GoalCreated.Type

export const GoalActivated = Event.define({ type: "work.goal.activated", ...options, schema: Base })
export type GoalActivated = typeof GoalActivated.Type

export const GoalPauseRequested = Event.define({ type: "work.goal.pause-requested", ...options, schema: Base })
export type GoalPauseRequested = typeof GoalPauseRequested.Type

export const GoalPaused = Event.define({ type: "work.goal.paused", ...options, schema: Base })
export type GoalPaused = typeof GoalPaused.Type

export const GoalCancelRequested = Event.define({ type: "work.goal.cancel-requested", ...options, schema: Base })
export type GoalCancelRequested = typeof GoalCancelRequested.Type

export const GoalCompleted = Event.define({ type: "work.goal.completed", ...options, schema: Base })
export type GoalCompleted = typeof GoalCompleted.Type

export const GoalBlocked = Event.define({
  type: "work.goal.blocked",
  ...options,
  schema: { ...Base, reason: Schema.String },
})
export type GoalBlocked = typeof GoalBlocked.Type

export const GoalCancelled = Event.define({
  type: "work.goal.cancelled",
  ...options,
  schema: { ...Base, reason: Schema.String.pipe(optional) },
})
export type GoalCancelled = typeof GoalCancelled.Type

export const GoalBudgetExhausted = Event.define({
  type: "work.goal.budget-exhausted",
  ...options,
  schema: { ...Base, reason: Schema.String },
})
export type GoalBudgetExhausted = typeof GoalBudgetExhausted.Type

export const GoalReplanRequested = Event.define({
  type: "work.goal.replan-requested",
  ...options,
  schema: { ...Base, reason: Schema.String, info: TaskInfo },
})
export type GoalReplanRequested = typeof GoalReplanRequested.Type

export const GoalPlacementAssigned = Event.define({
  type: "work.goal.placement-assigned",
  ...options,
  schema: { ...Base, workerID: WorkerID, reason: Schema.String.pipe(optional) },
})
export type GoalPlacementAssigned = typeof GoalPlacementAssigned.Type

export const GoalPlacementReleased = Event.define({
  type: "work.goal.placement-released",
  ...options,
  schema: { ...Base, workerID: WorkerID, reason: Schema.String.pipe(optional) },
})
export type GoalPlacementReleased = typeof GoalPlacementReleased.Type

export const TaskCreated = Event.define({
  type: "work.task.created",
  ...options,
  schema: { ...Base, info: TaskInfo },
})
export type TaskCreated = typeof TaskCreated.Type

export const TaskGraphPlanned = Event.define({
  type: "work.task-graph.planned",
  ...options,
  schema: { ...Base, plannerTaskID: TaskID, tasks: Schema.Array(TaskInfo) },
})
export type TaskGraphPlanned = typeof TaskGraphPlanned.Type

export const TaskGraphExpanded = Event.define({
  type: "work.task-graph.expanded",
  ...options,
  schema: { ...Base, tasks: Schema.Array(TaskInfo) },
})
export type TaskGraphExpanded = typeof TaskGraphExpanded.Type

export const TaskGraphReplanned = Event.define({
  type: "work.task-graph.replanned",
  ...options,
  schema: {
    ...Base,
    architectTaskID: TaskID,
    supersededTaskIDs: Schema.Array(TaskID),
    tasks: Schema.Array(TaskInfo),
  },
})
export type TaskGraphReplanned = typeof TaskGraphReplanned.Type

function taskTransition<const Type extends string, Status extends Schema.Codec<unknown, unknown>>(
  type: Type,
  status: Status,
) {
  return Event.define({ type, ...options, schema: { ...Base, taskID: TaskID, status } })
}

export const TaskReadied = taskTransition("work.task.readied", Schema.Literal("ready"))
export const TaskStarted = taskTransition("work.task.started", Schema.Literal("running"))
export const TaskVerificationStarted = taskTransition("work.task.verification-started", Schema.Literal("verifying"))
export const TaskReviewStarted = taskTransition("work.task.review-started", Schema.Literal("reviewing"))
export const TaskMergeStarted = Event.define({
  type: "work.task.merge-started",
  ...options,
  schema: {
    ...Base,
    taskID: TaskID,
    status: Schema.Literal("merging"),
    source: Schema.String,
    destination: Schema.String,
    changes: Schema.String.pipe(optional),
    artifact: ArtifactReference.pipe(optional),
    digest: Schema.String,
  },
})
export const TaskMerged = Event.define({
  type: "work.task.merged",
  ...options,
  schema: { ...Base, taskID: TaskID, status: Schema.Literal("completed"), digest: Schema.String },
})
export const TaskMergeConflicted = Event.define({
  type: "work.task.merge-conflicted",
  ...options,
  schema: {
    ...Base,
    taskID: TaskID,
    status: Schema.Literal("blocked"),
    digest: Schema.String,
    reason: Schema.String,
  },
})
export const TaskIsolationArchived = Event.define({
  type: "work.task.isolation-archived",
  ...options,
  schema: {
    ...Base,
    taskID: TaskID,
    artifact: ArtifactReference,
    reason: Schema.Literals(["cancelled", "superseded"]),
  },
})
export const TaskReworkRequested = Event.define({
  type: "work.task.rework-requested",
  ...options,
  schema: { ...Base, taskID: TaskID, status: Schema.Literal("rework"), reason: Schema.String },
})
export const TaskCompleted = taskTransition("work.task.completed", Schema.Literal("completed"))
export const TaskBlocked = Event.define({
  type: "work.task.blocked",
  ...options,
  schema: { ...Base, taskID: TaskID, status: Schema.Literal("blocked"), reason: Schema.String },
})
export const TaskCancelled = Event.define({
  type: "work.task.cancelled",
  ...options,
  schema: {
    ...Base,
    taskID: TaskID,
    status: Schema.Literal("cancelled"),
    reason: Schema.String.pipe(optional),
  },
})

export const AttemptAdmitted = Event.define({
  type: "work.attempt.admitted",
  ...options,
  schema: { ...Base, info: AttemptInfo },
})
export type AttemptAdmitted = typeof AttemptAdmitted.Type

export const AttemptStarted = Event.define({
  type: "work.attempt.started",
  ...options,
  schema: { ...Base, attemptID: AttemptID, ownerID: Schema.String, fence: NonNegativeInt },
})
export type AttemptStarted = typeof AttemptStarted.Type

export const AttemptSettled = Event.define({
  type: "work.attempt.settled",
  ...options,
  schema: {
    ...Base,
    attemptID: AttemptID,
    status: AttemptStatus,
    ownerID: Schema.String.pipe(optional),
    fence: NonNegativeInt.pipe(optional),
    failure: Failure.pipe(optional),
  },
})
export type AttemptSettled = typeof AttemptSettled.Type

export const EvidenceRecorded = Event.define({
  type: "work.evidence.recorded",
  ...options,
  schema: { ...Base, info: EvidenceInfo },
})
export type EvidenceRecorded = typeof EvidenceRecorded.Type

export const EvaluationRecorded = Event.define({
  type: "work.evaluation.recorded",
  ...options,
  schema: { ...Base, info: EvaluationInfo },
})
export type EvaluationRecorded = typeof EvaluationRecorded.Type

export const TaskHandoffRecorded = Event.define({
  type: "work.task.handoff-recorded",
  ...options,
  schema: { ...Base, info: HandoffInfo },
})
export type TaskHandoffRecorded = typeof TaskHandoffRecorded.Type

export const TaskHandoffRouted = Event.define({
  type: "work.task.handoff-routed",
  ...options,
  schema: { ...Base, handoffID: HandoffID, recipientTaskIDs: Schema.Array(TaskID) },
})
export type TaskHandoffRouted = typeof TaskHandoffRouted.Type

export const ProjectMemoryResolved = Event.define({
  type: "work.project-memory.resolved",
  ...options,
  schema: { ...Base, info: MemoryResolutionInfo },
})
export type ProjectMemoryResolved = typeof ProjectMemoryResolved.Type

export const DurableDefinitions = Event.inventory(
  GoalCreated,
  GoalActivated,
  GoalPauseRequested,
  GoalPaused,
  GoalCancelRequested,
  GoalCompleted,
  GoalBlocked,
  GoalCancelled,
  GoalBudgetExhausted,
  GoalReplanRequested,
  GoalPlacementAssigned,
  GoalPlacementReleased,
  TaskCreated,
  TaskGraphPlanned,
  TaskGraphExpanded,
  TaskGraphReplanned,
  TaskReadied,
  TaskStarted,
  TaskVerificationStarted,
  TaskReviewStarted,
  TaskMergeStarted,
  TaskMerged,
  TaskMergeConflicted,
  TaskIsolationArchived,
  TaskReworkRequested,
  TaskCompleted,
  TaskBlocked,
  TaskCancelled,
  AttemptAdmitted,
  AttemptStarted,
  AttemptSettled,
  EvidenceRecorded,
  EvaluationRecorded,
  TaskHandoffRecorded,
  TaskHandoffRouted,
  ProjectMemoryResolved,
)

export const Definitions = DurableDefinitions
export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" })
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "WorkDurableEvent" })
export type DurableEvent = typeof Durable.Type
