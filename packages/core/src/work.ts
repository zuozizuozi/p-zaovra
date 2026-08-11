export * as Work from "./work"

import {
  ArtifactDigest,
  ArtifactCollectionReport,
  ArtifactLifecycleInfo,
  ArtifactReference,
  AttemptID,
  AttemptInfo,
  AttemptKind,
  AttemptStatus,
  AttemptTime,
  Budget,
  CommandVerifier,
  ControllerDispatchInfo,
  ControllerDispatchSignal,
  ControllerID,
  ControllerInfo,
  ControllerRuntimeID,
  ControllerStatus,
  Criterion,
  CriterionID,
  EvaluationID,
  EvaluationInfo,
  EvidenceID,
  EvidenceInfo,
  EvidenceKind,
  Failure,
  FailureKind,
  FileVerifier,
  Finding,
  GoalID,
  GoalInfo,
  GoalStatus,
  GoalTime,
  HandoffID,
  HandoffInfo,
  HandoffItem,
  HandoffItemKind,
  HandoffOutput,
  MemoryResolutionID,
  MemoryResolutionInfo,
  MemoryScope,
  PlanIsolation,
  PlanOutput,
  PlanRole,
  PlanTask,
  ProjectMemoryCandidate,
  ProjectMemoryEntry,
  ProjectMemoryView,
  ReplanOutput,
  RoleCapability,
  RoleContract,
  RoleID,
  ReviewCriterion,
  ReviewOutput,
  TaskID,
  TaskInfo,
  TaskStatus,
  TaskTime,
  Usage,
  Verifier,
  Verdict,
  WorkspaceAccess,
  WorkerCapability,
  WorkerCredentialStatus,
  WorkerEnrollment,
  WorkerAssignmentInfo,
  WorkerAgentOperation,
  WorkerAgentResult,
  WorkerCommandOperation,
  WorkerCommandResult,
  WorkerExecutionMode,
  WorkerFileOperation,
  WorkerFileResult,
  WorkerGitDiffCapture,
  WorkerID,
  WorkerInfo,
  WorkerJobAssignment,
  WorkerJobCancellation,
  WorkerJobArtifactContent,
  WorkerJobArtifactInfo,
  WorkerJobDetail,
  WorkerJobID,
  WorkerJobInfo,
  WorkerJobLogEntry,
  WorkerJobLogStream,
  WorkerJobOperation,
  WorkerJobOutboxState,
  WorkerJobResult,
  WorkerJobStatus,
  WorkerLeaseInfo,
  WorkerLocationMapping,
  WorkerPendingArtifact,
  WorkerPollInfo,
  WorkerRuntimeID,
  WorkerStatus,
  GoalPlacementInfo,
} from "@zaovra-ai/schema/work"
import { WorkEvent } from "@zaovra-ai/schema/work-event"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { Location } from "./location"
import { WorkExecution } from "./work/execution"
import { WorkAccessFailure } from "./work/access-failure"
import { WorkIsolation } from "./work/isolation"
import { WorkMemory } from "./work/memory"
import { WorkProjector } from "./work/projector"
import { WorkRole } from "./work/role"
import { WorkStateMachine } from "./work/state-machine"
import { WorkStore } from "./work/store"

export {
  ArtifactDigest,
  ArtifactCollectionReport,
  ArtifactLifecycleInfo,
  ArtifactReference,
  AttemptID,
  AttemptInfo,
  AttemptKind,
  AttemptStatus,
  AttemptTime,
  Budget,
  CommandVerifier,
  ControllerDispatchInfo,
  ControllerDispatchSignal,
  ControllerID,
  ControllerInfo,
  ControllerRuntimeID,
  ControllerStatus,
  Criterion,
  CriterionID,
  EvaluationID,
  EvaluationInfo,
  EvidenceID,
  EvidenceInfo,
  EvidenceKind,
  Failure,
  FailureKind,
  FileVerifier,
  Finding,
  GoalID,
  GoalInfo,
  GoalStatus,
  GoalTime,
  HandoffID,
  HandoffInfo,
  HandoffItem,
  HandoffItemKind,
  HandoffOutput,
  MemoryResolutionID,
  MemoryResolutionInfo,
  MemoryScope,
  PlanIsolation,
  PlanOutput,
  PlanRole,
  PlanTask,
  ProjectMemoryCandidate,
  ProjectMemoryEntry,
  ProjectMemoryView,
  ReplanOutput,
  RoleCapability,
  RoleContract,
  RoleID,
  ReviewCriterion,
  ReviewOutput,
  TaskID,
  TaskInfo,
  TaskStatus,
  TaskTime,
  Usage,
  Verifier,
  Verdict,
  WorkspaceAccess,
  WorkerCapability,
  WorkerCredentialStatus,
  WorkerEnrollment,
  WorkerAssignmentInfo,
  WorkerAgentOperation,
  WorkerAgentResult,
  WorkerCommandOperation,
  WorkerCommandResult,
  WorkerExecutionMode,
  WorkerFileOperation,
  WorkerFileResult,
  WorkerGitDiffCapture,
  WorkerID,
  WorkerInfo,
  WorkerJobAssignment,
  WorkerJobCancellation,
  WorkerJobArtifactContent,
  WorkerJobArtifactInfo,
  WorkerJobDetail,
  WorkerJobID,
  WorkerJobInfo,
  WorkerJobLogEntry,
  WorkerJobLogStream,
  WorkerJobOperation,
  WorkerJobOutboxState,
  WorkerJobResult,
  WorkerJobStatus,
  WorkerLeaseInfo,
  WorkerLocationMapping,
  WorkerPendingArtifact,
  WorkerPollInfo,
  WorkerRuntimeID,
  WorkerStatus,
  GoalPlacementInfo,
}

export const Event = WorkEvent
const encodeLocation = Schema.encodeSync(Location.Ref)
const encodeCriterion = Schema.encodeSync(Criterion)
const encodeBudget = Schema.encodeSync(Budget)

export type CriterionInput = Omit<Criterion, "id"> & { readonly id?: CriterionID }
export type TaskInput = {
  readonly id?: TaskID
  readonly title: string
  readonly instructions: string
  readonly dependsOn?: ReadonlyArray<TaskID>
  readonly role?: string
  readonly location?: Location.Ref
  readonly criteria?: ReadonlyArray<CriterionID>
}
export type ExpandTaskInput = TaskInput & { readonly id: TaskID }
export type ExpandInput = {
  readonly goalID: GoalID
  readonly tasks: ReadonlyArray<ExpandTaskInput>
}
export type ReplanInput = {
  readonly goalID: GoalID
  readonly taskID: TaskID
  readonly reason: string
}
export type ResolveMemoryInput = {
  readonly goalID: GoalID
  readonly key: string
  readonly handoffID: HandoffID
  readonly itemDigest: string
  readonly resolver: string
  readonly reason?: string
}
export type UpdateMemoryInput = {
  readonly goalID: GoalID
  readonly key: string
  readonly kind: HandoffItemKind
  readonly text: string
  readonly reference?: string
  readonly resolver: string
  readonly reason?: string
}
export type DeleteMemoryInput = {
  readonly goalID: GoalID
  readonly key: string
  readonly resolver: string
  readonly reason?: string
}
type DesiredTask = {
  readonly id: TaskID
  readonly title: string
  readonly instructions: string
  readonly dependsOn: ReadonlyArray<TaskID>
  readonly role: string
  readonly location?: Location.Ref
  readonly criteria: ReadonlyArray<CriterionID>
}
export type CreateInput = {
  readonly id?: GoalID
  readonly location: Location.Ref
  readonly objective: string
  readonly acceptanceCriteria: ReadonlyArray<CriterionInput>
  readonly roleContracts?: ReadonlyArray<RoleContract>
  readonly workerID?: WorkerID
  readonly budget?: Budget
  readonly planning?: boolean
  readonly tasks?: ReadonlyArray<TaskInput>
}
export type Created = { readonly goal: GoalInfo; readonly tasks: ReadonlyArray<TaskInfo> }

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Work.NotFoundError", {
  goalID: GoalID,
}) {}

export class CreateConflictError extends Schema.TaggedErrorClass<CreateConflictError>()("Work.CreateConflictError", {
  goalID: GoalID,
  message: Schema.String,
}) {}

export class ResumeConflictError extends Schema.TaggedErrorClass<ResumeConflictError>()("Work.ResumeConflictError", {
  goalID: GoalID,
  message: Schema.String,
}) {}

export class ResolveUnknownConflictError extends Schema.TaggedErrorClass<ResolveUnknownConflictError>()(
  "Work.ResolveUnknownConflictError",
  {
    goalID: GoalID,
    attemptID: AttemptID,
    message: Schema.String,
  },
) {}

export class ExpandConflictError extends Schema.TaggedErrorClass<ExpandConflictError>()("Work.ExpandConflictError", {
  goalID: GoalID,
  message: Schema.String,
}) {}

export class ReplanConflictError extends Schema.TaggedErrorClass<ReplanConflictError>()("Work.ReplanConflictError", {
  goalID: GoalID,
  taskID: TaskID,
  message: Schema.String,
}) {}

export class ResolveMemoryConflictError extends Schema.TaggedErrorClass<ResolveMemoryConflictError>()(
  "Work.ResolveMemoryConflictError",
  {
    goalID: GoalID,
    key: Schema.String,
    message: Schema.String,
  },
) {}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Created, CreateConflictError>
  readonly expand: (input: ExpandInput) => Effect.Effect<ReadonlyArray<TaskInfo>, NotFoundError | ExpandConflictError>
  readonly requestReplan: (input: ReplanInput) => Effect.Effect<TaskInfo, NotFoundError | ReplanConflictError>
  readonly resolveMemory: (
    input: ResolveMemoryInput,
  ) => Effect.Effect<MemoryResolutionInfo, NotFoundError | ResolveMemoryConflictError>
  readonly updateMemory: (
    input: UpdateMemoryInput,
  ) => Effect.Effect<MemoryResolutionInfo, NotFoundError | ResolveMemoryConflictError>
  readonly deleteMemory: (
    input: DeleteMemoryInput,
  ) => Effect.Effect<MemoryResolutionInfo, NotFoundError | ResolveMemoryConflictError>
  readonly list: Effect.Effect<ReadonlyArray<GoalInfo>>
  readonly get: (goalID: GoalID) => Effect.Effect<GoalInfo, NotFoundError>
  readonly tasks: (goalID: GoalID) => Effect.Effect<ReadonlyArray<TaskInfo>, NotFoundError>
  readonly active: Effect.Effect<ReadonlySet<GoalID>>
  readonly resume: (goalID: GoalID) => Effect.Effect<void, NotFoundError | ResumeConflictError>
  readonly pause: (goalID: GoalID) => Effect.Effect<void, NotFoundError>
  readonly cancel: (goalID: GoalID, reason?: string) => Effect.Effect<void, NotFoundError>
  readonly resolveUnknown: (
    goalID: GoalID,
    attemptID: AttemptID,
    reason?: string,
  ) => Effect.Effect<void, NotFoundError | ResolveUnknownConflictError>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/Work") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const execution = yield* WorkExecution.Service
    const isolation = yield* WorkIsolation.Service
    const store = yield* WorkStore.Service

    const get = Effect.fn("Work.get")(function* (goalID: GoalID) {
      const goal = yield* store.getGoal(goalID)
      if (!goal) return yield* new NotFoundError({ goalID })
      return goal
    })

    const tasks = Effect.fn("Work.tasks")(function* (goalID: GoalID) {
      yield* get(goalID)
      return yield* store.tasks(goalID)
    })

    const mutateMemory = Effect.fn("Work.mutateMemory")(function* (
      input: UpdateMemoryInput | DeleteMemoryInput,
      action: "replace" | "delete",
    ) {
      const goal = yield* get(input.goalID)
      const timestamp = yield* DateTime.now
      const memory = WorkMemory.view(
        yield* store.projectHandoffs(goal.location, 512),
        yield* store.projectMemoryResolutions(goal.location, 512),
        timestamp,
      )
      const entry = memory.entries.find((candidate) => candidate.key === input.key)
      if (!entry)
        return yield* new ResolveMemoryConflictError({
          goalID: input.goalID,
          key: input.key,
          message: `Project-memory key is unavailable: ${input.key}`,
        })
      const selected = entry.resolution
        ? entry.candidates.find(
            (candidate) =>
              candidate.handoffID === entry.resolution?.handoffID &&
              candidate.itemDigest === entry.resolution?.itemDigest,
          )
        : undefined
      const candidate = selected ?? entry.candidates.at(-1)
      if (!candidate)
        return yield* new ResolveMemoryConflictError({
          goalID: input.goalID,
          key: input.key,
          message: `Project-memory key has no active source: ${input.key}`,
        })
      const value =
        action === "replace" && "text" in input
          ? HandoffItem.make({
              kind: input.kind,
              text: input.text,
              reference: input.reference,
              memory: "project",
              key: input.key,
            })
          : undefined
      const info = MemoryResolutionInfo.make({
        id: MemoryResolutionID.create(),
        goalID: input.goalID,
        location: goal.location,
        key: input.key,
        handoffID: candidate.handoffID,
        handoffDigest: candidate.digest,
        itemDigest: candidate.itemDigest,
        action,
        value,
        resolver: input.resolver,
        reason: input.reason,
        createdAt: timestamp,
      })
      yield* events.publish(Event.ProjectMemoryResolved, { goalID: input.goalID, info, timestamp })
      return info
    })

    return Service.of({
      create: Effect.fn("Work.create")(function* (input) {
        const goalID = input.id ?? GoalID.create()
        if (input.planning && input.tasks?.length)
          return yield* new CreateConflictError({
            goalID,
            message: "Planning and an explicit Task graph are mutually exclusive",
          })
        const existing = yield* store.getGoal(goalID)
        const roleContracts = existing
          ? (existing.roleContracts ?? WorkRole.contracts)
          : (input.roleContracts ?? WorkRole.contracts)
        const acceptanceCriteria = input.acceptanceCriteria.map((criterion, index) => ({
          ...criterion,
          id: criterion.id ?? deterministicCriterionID(goalID, index),
        }))
        if (new Set(acceptanceCriteria.map((criterion) => criterion.id)).size !== acceptanceCriteria.length)
          return yield* new CreateConflictError({ goalID, message: "Criterion IDs must be unique" })
        if (
          existing &&
          !isDeepStrictEqual(
            {
              location: encodeLocation(existing.location),
              objective: existing.objective,
              acceptanceCriteria: existing.acceptanceCriteria.map((criterion) => encodeCriterion(criterion)),
              budget: existing.budget ? encodeBudget(existing.budget) : undefined,
            },
            {
              location: encodeLocation(input.location),
              objective: input.objective,
              acceptanceCriteria: acceptanceCriteria.map((criterion) => encodeCriterion(criterion)),
              budget: input.budget ? encodeBudget(input.budget) : undefined,
            },
          )
        ) {
          return yield* new CreateConflictError({ goalID, message: "Goal ID is already used by different input" })
        }

        const desired = (
          input.tasks?.length
            ? input.tasks
            : input.planning
              ? [
                  {
                    title: `Plan: ${input.objective}`,
                    instructions: "Inspect the project and produce a validated Task dependency graph.",
                    role: "work-planner",
                    criteria: [],
                  },
                ]
              : [
                  {
                    title: input.objective,
                    instructions: input.objective,
                    role: "build",
                    criteria: acceptanceCriteria.map((criterion) => criterion.id),
                  },
                ]
        ).map((task, index) => ({
          id: task.id ?? deterministicTaskID(goalID, index),
          title: task.title,
          instructions: task.instructions,
          dependsOn: Array.from(task.dependsOn ?? []),
          role: task.role ?? "build",
          location: task.location,
          criteria: Array.from(task.criteria ?? acceptanceCriteria.map((criterion) => criterion.id)),
        }))
        if (new Set(desired.map((task) => task.id)).size !== desired.length)
          return yield* new CreateConflictError({ goalID, message: "Task IDs must be unique" })
        if (!input.planning && desired.some((task) => internalRole(task.role)))
          return yield* new CreateConflictError({
            goalID,
            message: "WorkGraph runtime roles cannot be assigned directly",
          })
        const validated = validateTaskGraph(acceptanceCriteria, desired, roleContracts)
        if ("message" in validated) return yield* new CreateConflictError({ goalID, message: validated.message })

        if (!existing) {
          const timestamp = yield* DateTime.now
          yield* events.publish(Event.GoalCreated, {
            goalID,
            timestamp,
            info: GoalInfo.make({
              id: goalID,
              location: input.location,
              objective: input.objective,
              acceptanceCriteria,
              roleContracts,
              workerID: input.workerID,
              status: "draft",
              budget: input.budget,
              usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
              time: { created: timestamp, updated: timestamp },
              revision: 0,
            }),
          })
        }

        const stored = new Map((yield* store.tasks(goalID)).map((task) => [task.id, task]))
        const desiredIDs = new Set(validated.tasks.map((task) => task.id))
        const unexpected = Array.from(stored.keys()).find((taskID) => !desiredIDs.has(taskID))
        if (unexpected && !input.planning)
          return yield* new CreateConflictError({
            goalID,
            message: `Goal already contains Task ${unexpected}, which is absent from the requested graph`,
          })
        for (const task of validated.tasks) {
          const current = stored.get(task.id)
          if (
            current &&
            !isDeepStrictEqual(
              {
                title: current.title,
                instructions: current.instructions,
                dependsOn: current.dependsOn,
                role: current.role,
                location: current.location ? encodeLocation(current.location) : undefined,
                criteria: current.criteria,
              },
              {
                title: task.title,
                instructions: task.instructions,
                dependsOn: task.dependsOn,
                role: task.role,
                location: task.location ? encodeLocation(task.location) : undefined,
                criteria: task.criteria,
              },
            )
          ) {
            return yield* new CreateConflictError({
              goalID,
              message: `Task ID ${task.id} is already used by different input`,
            })
          }
          if (current) continue
          const timestamp = yield* DateTime.now
          yield* events.publish(Event.TaskCreated, {
            goalID,
            timestamp,
            info: TaskInfo.make({
              ...task,
              goalID,
              status: "pending",
              attemptCount: 0,
              time: { created: timestamp, updated: timestamp },
              revision: 0,
            }),
          })
        }

        const goal = yield* store.getGoal(goalID)
        if (!goal) return yield* Effect.die(`Goal not projected: ${goalID}`)
        return { goal, tasks: yield* store.tasks(goalID) }
      }),
      expand: Effect.fn("Work.expand")(function* (input) {
        const goal = yield* get(input.goalID)
        if (input.tasks.length === 0 || input.tasks.length > 24)
          return yield* new ExpandConflictError({
            goalID: input.goalID,
            message: "A graph expansion must contain between 1 and 24 Tasks",
          })
        const desired = input.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          instructions: task.instructions,
          dependsOn: Array.from(task.dependsOn ?? []),
          role: task.role ?? "build",
          location: task.location,
          criteria: Array.from(task.criteria ?? []),
        }))
        if (new Set(desired.map((task) => task.id)).size !== desired.length)
          return yield* new ExpandConflictError({ goalID: input.goalID, message: "Expansion Task IDs must be unique" })
        if (desired.some((task) => internalRole(task.role)))
          return yield* new ExpandConflictError({
            goalID: input.goalID,
            message: "WorkGraph runtime roles cannot be injected through graph expansion",
          })
        const stored = yield* store.tasks(input.goalID)
        const existing = new Map(stored.map((task) => [task.id, task]))
        const reused = desired.filter((task) => existing.has(task.id))
        if (reused.length > 0) {
          if (reused.length === desired.length && desired.every((task) => sameTask(existing.get(task.id)!, task)))
            return reused.map((task) => existing.get(task.id)!)
          return yield* new ExpandConflictError({
            goalID: input.goalID,
            message: `Expansion reuses Task ${reused[0].id} with conflicting or partial input`,
          })
        }
        if (goal.status !== "active" && goal.status !== "paused")
          return yield* new ExpandConflictError({
            goalID: input.goalID,
            message: `A ${goal.status} Goal cannot expand its Task graph`,
          })
        if (stored.length + desired.length > 128)
          return yield* new ExpandConflictError({
            goalID: input.goalID,
            message: "A Goal cannot contain more than 128 Tasks",
          })
        const combined = [
          ...stored.map((task) => ({
            id: task.id,
            title: task.title,
            instructions: task.instructions,
            dependsOn: task.dependsOn,
            role: task.role,
            location: task.location,
            criteria: task.criteria,
          })),
          ...desired,
        ]
        const validated = validateTaskGraph(goal.acceptanceCriteria, combined, goal.roleContracts ?? WorkRole.contracts)
        if ("message" in validated)
          return yield* new ExpandConflictError({ goalID: input.goalID, message: validated.message })
        const timestamp = yield* DateTime.now
        const additions = desired.map((task) =>
          TaskInfo.make({
            ...task,
            goalID: input.goalID,
            status: "pending",
            attemptCount: 0,
            time: { created: timestamp, updated: timestamp },
            revision: 0,
          }),
        )
        yield* events.publish(Event.TaskGraphExpanded, {
          goalID: input.goalID,
          tasks: additions,
          timestamp,
        })
        const addedIDs = new Set(additions.map((task) => task.id))
        const projected = (yield* store.tasks(input.goalID)).filter((task) => addedIDs.has(task.id))
        if (goal.status === "active") yield* execution.wake(input.goalID)
        return projected
      }),
      requestReplan: Effect.fn("Work.requestReplan")(function* (input) {
        const goal = yield* get(input.goalID)
        const goalTasks = yield* store.tasks(input.goalID)
        const stored = goalTasks.find((task) => task.id === input.taskID)
        if (stored) {
          if (
            stored.role !== "work-architect" ||
            stored.instructions !== input.reason ||
            stored.dependsOn.length > 0 ||
            stored.criteria.length > 0
          )
            return yield* new ReplanConflictError({
              goalID: input.goalID,
              taskID: input.taskID,
              message: `Task ID ${input.taskID} is already used by different input`,
            })
          if (!WorkStateMachine.isTaskTerminal(stored.status)) yield* execution.resume(input.goalID)
          return stored
        }
        if (
          goal.status !== "active" &&
          goal.status !== "paused" &&
          goal.status !== "blocked" &&
          goal.status !== "budget_exhausted"
        )
          return yield* new ReplanConflictError({
            goalID: input.goalID,
            taskID: input.taskID,
            message: `A ${goal.status} Goal cannot be replanned`,
          })
        const architects = goalTasks.filter((task) => task.role === "work-architect")
        if (goalTasks.length > 126)
          return yield* new ReplanConflictError({
            goalID: input.goalID,
            taskID: input.taskID,
            message: "Goal has insufficient capacity for an Architect recovery graph",
          })
        if (architects.length >= (goal.budget?.maxReplans ?? 2))
          return yield* new ReplanConflictError({
            goalID: input.goalID,
            taskID: input.taskID,
            message: `Goal exhausted its replan budget of ${goal.budget?.maxReplans ?? 2}`,
          })
        const active = architects.find((task) => !WorkStateMachine.isTaskTerminal(task.status))
        if (active)
          return yield* new ReplanConflictError({
            goalID: input.goalID,
            taskID: input.taskID,
            message: `Architect Task ${active.id} is still ${active.status}`,
          })
        const timestamp = yield* DateTime.now
        const info = TaskInfo.make({
          id: input.taskID,
          goalID: input.goalID,
          title: `Architect replan #${architects.length + 1}`,
          instructions: input.reason,
          dependsOn: [],
          role: "work-architect",
          status: "pending",
          criteria: [],
          attemptCount: 0,
          time: { created: timestamp, updated: timestamp },
          revision: 0,
        })
        yield* events.publish(Event.GoalReplanRequested, {
          goalID: input.goalID,
          reason: input.reason,
          info,
          timestamp,
        })
        yield* execution.resume(input.goalID)
        return (yield* store.getTask(input.taskID)) ?? info
      }),
      resolveMemory: Effect.fn("Work.resolveMemory")(function* (input) {
        const goal = yield* get(input.goalID)
        const timestamp = yield* DateTime.now
        const memory = WorkMemory.view(
          yield* store.projectHandoffs(goal.location, 512),
          yield* store.projectMemoryResolutions(goal.location, 512),
          timestamp,
        )
        const entry = memory.entries.find((candidate) => candidate.key === input.key)
        if (!entry)
          return yield* new ResolveMemoryConflictError({
            goalID: input.goalID,
            key: input.key,
            message: `Project-memory key is unavailable: ${input.key}`,
          })
        if (entry.status === "current")
          return yield* new ResolveMemoryConflictError({
            goalID: input.goalID,
            key: input.key,
            message: `Project-memory key ${input.key} is not conflicted`,
          })
        const candidate = entry.candidates.find(
          (item) => item.handoffID === input.handoffID && item.itemDigest === input.itemDigest,
        )
        if (!candidate)
          return yield* new ResolveMemoryConflictError({
            goalID: input.goalID,
            key: input.key,
            message: `Selected project-memory candidate is unavailable for ${input.key}`,
          })
        const info = MemoryResolutionInfo.make({
          id: MemoryResolutionID.create(),
          goalID: input.goalID,
          location: goal.location,
          key: input.key,
          handoffID: candidate.handoffID,
          handoffDigest: candidate.digest,
          itemDigest: candidate.itemDigest,
          action: "select",
          resolver: input.resolver,
          reason: input.reason,
          createdAt: timestamp,
        })
        yield* events.publish(Event.ProjectMemoryResolved, {
          goalID: input.goalID,
          info,
          timestamp,
        })
        return info
      }),
      updateMemory: Effect.fn("Work.updateMemory")(function* (input) {
        return yield* mutateMemory(input, "replace")
      }),
      deleteMemory: Effect.fn("Work.deleteMemory")(function* (input) {
        return yield* mutateMemory(input, "delete")
      }),
      list: store.goals(),
      get,
      tasks,
      active: execution.active,
      resume: Effect.fn("Work.resume")(function* (goalID) {
        const goal = yield* get(goalID)
        if (goal.status === "draft" || goal.status === "paused") return yield* execution.wake(goalID)
        if (goal.status === "blocked") {
          const blocked = (yield* store.tasks(goalID)).filter((task) => task.status === "blocked")
          const resumable = (yield* Effect.forEach(blocked, (task) =>
            store
              .attempts(task.id)
              .pipe(
                Effect.map((attempts) =>
                  attempts.some(
                    (attempt) =>
                      attempt.failure !== undefined && WorkAccessFailure.recoverable(attempt.failure.message),
                  ),
                ),
              ),
          )).some(Boolean)
          if (resumable) return yield* execution.wake(goalID)
        }
        return yield* new ResumeConflictError({
          goalID,
          message:
            goal.status === "budget_exhausted"
              ? "A budget-exhausted Goal cannot be resumed; create a replacement Goal with a new budget"
              : `A ${goal.status} Goal cannot be resumed`,
        })
      }),
      pause: Effect.fn("Work.pause")(function* (goalID) {
        const goal = yield* get(goalID)
        if (goal.status !== "active") return
        yield* events.publish(Event.GoalPauseRequested, { goalID, timestamp: yield* DateTime.now })
        yield* execution.interrupt(goalID)
        const goalTasks = yield* store.tasks(goalID)
        const active = (yield* Effect.forEach(goalTasks, (task) => store.attempts(task.id)))
          .flat()
          .some((attempt) => attempt.status === "admitted" || attempt.status === "running")
        if (!active && (yield* get(goalID)).status === "pausing")
          yield* events.publish(Event.GoalPaused, { goalID, timestamp: yield* DateTime.now })
      }),
      cancel: Effect.fn("Work.cancel")(function* (goalID, reason) {
        const goal = yield* get(goalID)
        if (goal.status === "completed" || goal.status === "cancelled") return
        if (goal.status !== "cancelling")
          yield* events.publish(Event.GoalCancelRequested, { goalID, timestamp: yield* DateTime.now })
        yield* execution.interrupt(goalID)
        const goalTasks = yield* store.tasks(goalID)
        const activeAttempts = (yield* Effect.forEach(goalTasks, (task) => store.attempts(task.id)))
          .flat()
          .some((attempt) => attempt.status === "admitted" || attempt.status === "running")
        if (activeAttempts) return
        for (const task of goalTasks) {
          for (const attempt of yield* store.attempts(task.id)) {
            if (attempt.status !== "admitted" && attempt.status !== "running") continue
            yield* events.publish(Event.AttemptSettled, {
              goalID,
              attemptID: attempt.id,
              status: "cancelled",
              ownerID: attempt.ownerID,
              fence: attempt.fence,
              failure: { kind: "cancelled", message: reason ?? "Goal cancelled", retryable: false },
              timestamp: yield* DateTime.now,
            })
          }
          if (WorkStateMachine.isTaskTerminal(task.status)) continue
          yield* events.publish(Event.TaskCancelled, {
            goalID,
            taskID: task.id,
            status: "cancelled",
            reason,
            timestamp: yield* DateTime.now,
          })
        }
        for (const task of yield* store.tasks(goalID)) {
          if (task.status !== "cancelled") continue
          const artifact = yield* isolation.archive(goal, task)
          if (!artifact) continue
          yield* events.publish(Event.TaskIsolationArchived, {
            goalID,
            taskID: task.id,
            artifact,
            reason: "cancelled",
            timestamp: yield* DateTime.now,
          })
          yield* isolation.release(goal, task)
        }
        const current = yield* get(goalID)
        if (current.status === "completed" || current.status === "cancelled") return
        yield* events.publish(Event.GoalCancelled, { goalID, reason, timestamp: yield* DateTime.now })
      }),
      resolveUnknown: Effect.fn("Work.resolveUnknown")(function* (goalID, attemptID, reason) {
        const goal = yield* get(goalID)
        const attempt = yield* store.getAttempt(attemptID)
        if (!attempt || attempt.goalID !== goalID)
          return yield* new ResolveUnknownConflictError({
            goalID,
            attemptID,
            message: `Unknown Attempt ${attemptID} in Goal ${goalID}`,
          })
        const task = yield* store.getTask(attempt.taskID)
        if (!task) return yield* Effect.die(`Task not projected: ${attempt.taskID}`)
        if ((yield* store.attempts(task.id)).some((candidate) => candidate.number > attempt.number)) {
          if (goal.status === "active") return yield* execution.wake(goalID)
          return yield* Effect.void
        }
        if (attempt.status !== "unknown")
          return yield* new ResolveUnknownConflictError({
            goalID,
            attemptID,
            message: `Attempt ${attemptID} is ${attempt.status}, not unknown`,
          })

        if (goal.status === "blocked" && task.status === "blocked")
          yield* events.publish(Event.TaskReworkRequested, {
            goalID,
            taskID: task.id,
            status: "rework",
            reason: reason
              ? `Manual retry authorized for unknown Attempt ${attemptID}: ${reason}`
              : `Manual retry authorized for unknown Attempt ${attemptID}`,
            timestamp: yield* DateTime.now,
          })
        const currentGoal = yield* get(goalID)
        const currentTask = yield* store.getTask(task.id)
        if (currentGoal.status === "blocked" && currentTask?.status === "rework")
          yield* events.publish(Event.GoalActivated, { goalID, timestamp: yield* DateTime.now })
        const activated = yield* get(goalID)
        const rework = yield* store.getTask(task.id)
        if (activated.status !== "active" || rework?.status !== "rework")
          return yield* new ResolveUnknownConflictError({
            goalID,
            attemptID,
            message: `Goal ${goalID} and Task ${task.id} cannot retry this unknown Attempt from their current states`,
          })
        return yield* execution.resume(goalID)
      }),
    })
  }),
)

function deterministicTaskID(goalID: GoalID, index: number) {
  const suffix = goalID.slice("goal_".length)
  return TaskID.make(`task_${suffix}${index === 0 ? "" : `_${index}`}`)
}

function deterministicCriterionID(goalID: GoalID, index: number) {
  const suffix = goalID.slice("goal_".length)
  return CriterionID.make(`criterion_${suffix}${index === 0 ? "" : `_${index}`}`)
}

function internalRole(role: string) {
  return role === "work-planner" || role === "work-architect"
}

function sameTask(current: TaskInfo, desired: DesiredTask) {
  return isDeepStrictEqual(
    {
      title: current.title,
      instructions: current.instructions,
      dependsOn: current.dependsOn,
      role: current.role,
      location: current.location ? encodeLocation(current.location) : undefined,
      criteria: current.criteria,
    },
    {
      title: desired.title,
      instructions: desired.instructions,
      dependsOn: desired.dependsOn,
      role: desired.role,
      location: desired.location ? encodeLocation(desired.location) : undefined,
      criteria: desired.criteria,
    },
  )
}

function validateTaskGraph(
  criteria: ReadonlyArray<Criterion>,
  tasks: ReadonlyArray<DesiredTask>,
  roleContracts: ReadonlyArray<RoleContract>,
) {
  const invalidRole = tasks.find((task) => !internalRole(task.role) && !WorkRole.get(task.role, roleContracts))
  if (invalidRole) return { message: `Task ${invalidRole.id} uses unknown Role Contract ${invalidRole.role}` } as const
  const criterionIDs = new Set(criteria.map((criterion) => criterion.id))
  const invalidCriterion = tasks.find((task) => task.criteria.some((criterionID) => !criterionIDs.has(criterionID)))
  if (invalidCriterion) return { message: `Task ${invalidCriterion.id} references an unknown criterion` } as const

  const taskIDs = new Set(tasks.map((task) => task.id))
  const invalidDependency = tasks.find((task) => task.dependsOn.some((dependencyID) => !taskIDs.has(dependencyID)))
  if (invalidDependency) return { message: `Task ${invalidDependency.id} references an unknown dependency` } as const
  const selfDependent = tasks.find((task) => task.dependsOn.includes(task.id))
  if (selfDependent) return { message: `Task ${selfDependent.id} cannot depend on itself` } as const

  return topologicalTasks(tasks, [], new Set())
}

function topologicalTasks(
  remaining: ReadonlyArray<DesiredTask>,
  ordered: ReadonlyArray<DesiredTask>,
  completed: ReadonlySet<TaskID>,
): { readonly tasks: ReadonlyArray<DesiredTask> } | { readonly message: string } {
  if (remaining.length === 0) return { tasks: ordered }
  const ready = remaining.filter((task) => task.dependsOn.every((dependencyID) => completed.has(dependencyID)))
  if (ready.length === 0) return { message: "Task graph contains a dependency cycle" }
  const readyIDs = new Set(ready.map((task) => task.id))
  return topologicalTasks(
    remaining.filter((task) => !readyIDs.has(task.id)),
    [...ordered, ...ready],
    new Set([...completed, ...readyIDs]),
  )
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [EventV2.node, WorkExecution.node, WorkIsolation.node, WorkProjector.node, WorkStore.node],
})
