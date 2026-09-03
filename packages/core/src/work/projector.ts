export * as WorkProjector from "./projector"

import type { EffectDrizzleSqlite } from "@zaovra-ai/effect-drizzle-sqlite"
import { Work } from "@zaovra-ai/schema/work"
import { and, asc, count, eq, inArray } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { Hash } from "../util/hash"
import { SessionMessageTable, SessionTable } from "../session/sql"
import {
  WorkAttemptTable,
  WorkEvaluationTable,
  WorkEvidenceTable,
  WorkGoalTable,
  WorkHandoffTable,
  WorkLeaseTable,
  WorkMemoryResolutionTable,
  WorkTaskTable,
} from "./sql"
import { WorkHandoff } from "./handoff"
import { WorkStateMachine } from "./state-machine"
import { WorkRole } from "./role"

type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
type DurablePayload = { readonly durable?: { readonly seq: number } }
type TaskTransition = DurablePayload & {
  readonly data: {
    readonly goalID: Work.GoalID
    readonly taskID: Work.TaskID
    readonly status: Work.TaskStatus
    readonly timestamp: DateTime.Utc
  }
}

export class ProjectionError extends Error {}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service

    yield* events.project(Work.Event.GoalCreated, (event) =>
      Effect.gen(function* () {
        invariant(event.data.info.id === event.data.goalID, "Goal payload ID does not match aggregate")
        invariant(event.data.info.status === "draft", "A new Goal must start in draft")
        invariant(event.data.info.revision === 0, "A new Goal must start at revision zero")
        invariant(event.data.info.usage.attempts === 0, "A new Goal cannot start with attempt usage")
        invariant(event.data.info.usage.repairs === 0, "A new Goal cannot start with repair usage")
        const criterionIDs = event.data.info.acceptanceCriteria.map((criterion) => criterion.id)
        invariant(new Set(criterionIDs).size === criterionIDs.length, "Goal criteria must have unique IDs")
        const roleContracts = event.data.info.roleContracts ?? WorkRole.contracts
        invariant(roleContracts.length > 0 && roleContracts.length <= 32, "Goal Role Contract count is invalid")
        invariant(
          new Set(roleContracts.map((contract) => contract.id)).size === roleContracts.length,
          "Goal Role Contract IDs must be unique",
        )
        invariant(
          roleContracts.every(
            (contract) =>
              contract.agentID.trim().length > 0 &&
              contract.allowedIsolation.length > 0 &&
              contract.publishes.includes("result") &&
              new Set(contract.accepts).size === contract.accepts.length &&
              new Set(contract.publishes).size === contract.publishes.length,
          ),
          "Goal Role Contract is invalid",
        )
        const time = DateTime.toEpochMillis(event.data.timestamp)
        invariant(
          DateTime.toEpochMillis(event.data.info.time.created) === time &&
            DateTime.toEpochMillis(event.data.info.time.updated) === time,
          "Goal creation timestamps must match the event timestamp",
        )
        yield* db
          .insert(WorkGoalTable)
          .values({
            id: event.data.goalID,
            directory: event.data.info.location.directory,
            workspace_id: event.data.info.location.workspaceID,
            objective: event.data.info.objective,
            acceptance_criteria: Array.from(event.data.info.acceptanceCriteria),
            role_contracts: Array.from(roleContracts),
            worker_id: event.data.info.workerID,
            status: "draft",
            budget: event.data.info.budget,
            usage: event.data.info.usage,
            revision: revision(event),
            time_created: time,
            time_updated: time,
          })
          .run()
          .pipe(Effect.orDie)
      }),
    )

    yield* events.project(Work.Event.GoalActivated, (event) => projectGoalStatus(db, event, "active"))
    yield* events.project(Work.Event.GoalPauseRequested, (event) => projectGoalStatus(db, event, "pausing"))
    yield* events.project(Work.Event.GoalPaused, (event) => projectGoalStatus(db, event, "paused"))
    yield* events.project(Work.Event.GoalCancelRequested, (event) => projectGoalStatus(db, event, "cancelling"))
    yield* events.project(Work.Event.GoalCompleted, (event) =>
      Effect.gen(function* () {
        yield* assertCompletable(db, event.data.goalID)
        yield* projectGoalStatus(db, event, "completed")
      }),
    )
    yield* events.project(Work.Event.GoalBlocked, (event) => projectGoalStatus(db, event, "blocked"))
    yield* events.project(Work.Event.GoalCancelled, (event) => projectGoalStatus(db, event, "cancelled"))
    yield* events.project(Work.Event.GoalBudgetExhausted, (event) => projectGoalStatus(db, event, "budget_exhausted"))
    yield* events.project(Work.Event.GoalReplanRequested, (event) =>
      Effect.gen(function* () {
        const goal = yield* requireGoal(db, event.data.goalID)
        invariant(
          goal.status === "active" ||
            goal.status === "paused" ||
            goal.status === "blocked" ||
            goal.status === "budget_exhausted",
          `Cannot replan a Goal in ${goal.status}`,
        )
        invariant(event.data.info.id !== (event.data.goalID as string), "Architect Task ID must differ from Goal ID")
        invariant(
          event.data.info.goalID === event.data.goalID,
          "Architect Task payload Goal ID does not match aggregate",
        )
        invariant(event.data.info.role === "work-architect", "A replan requires a work-architect Task")
        invariant(event.data.info.status === "pending", "A new Architect Task must start pending")
        invariant(event.data.info.attemptCount === 0, "A new Architect Task cannot start with attempts")
        invariant(event.data.info.revision === 0, "A new Architect Task must start at revision zero")
        invariant(event.data.info.dependsOn.length === 0, "An Architect Task cannot have dependencies")
        invariant(event.data.info.criteria.length === 0, "An Architect Task cannot own acceptance criteria")
        const existing = yield* db
          .select({ id: WorkTaskTable.id })
          .from(WorkTaskTable)
          .where(eq(WorkTaskTable.goal_id, event.data.goalID))
          .all()
          .pipe(Effect.orDie)
        invariant(existing.length <= 126, "Goal has insufficient capacity for an Architect recovery graph")
        invariant(
          existing.every((task) => task.id !== event.data.info.id),
          "Architect Task ID already exists",
        )
        const time = DateTime.toEpochMillis(event.data.timestamp)
        yield* db
          .insert(WorkTaskTable)
          .values({
            id: event.data.info.id,
            goal_id: event.data.goalID,
            title: event.data.info.title,
            instructions: event.data.info.instructions,
            depends_on: [],
            role: "work-architect",
            directory: event.data.info.location?.directory,
            workspace_id: event.data.info.location?.workspaceID,
            status: "pending",
            criteria: [],
            attempt_count: 0,
            revision: revision(event),
            time_created: time,
            time_updated: time,
          })
          .run()
          .pipe(Effect.orDie)
        if (goal.status !== "active") WorkStateMachine.goal(goal.status, "active")
        yield* db
          .update(WorkGoalTable)
          .set({ status: "active", revision: revision(event), time_updated: time, time_completed: null })
          .where(eq(WorkGoalTable.id, event.data.goalID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    yield* events.project(Work.Event.GoalPlacementAssigned, (event) =>
      Effect.gen(function* () {
        const goal = yield* requireGoal(db, event.data.goalID)
        invariant(!WorkStateMachine.isGoalTerminal(goal.status), `Cannot place a terminal Goal in ${goal.status}`)
        invariant(goal.worker_id !== event.data.workerID, "Goal is already assigned to this Worker")
        invariant(!event.data.reason || event.data.reason.length <= 4_000, "Goal placement reason is invalid")
        const lease = yield* db
          .select({ expiresAt: WorkLeaseTable.expires_at })
          .from(WorkLeaseTable)
          .where(eq(WorkLeaseTable.goal_id, event.data.goalID))
          .get()
          .pipe(Effect.orDie)
        invariant(
          !lease || lease.expiresAt <= DateTime.toEpochMillis(event.data.timestamp),
          "Cannot reassign a Goal while its ownership lease is active",
        )
        yield* db
          .update(WorkGoalTable)
          .set({
            worker_id: event.data.workerID,
            revision: revision(event),
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(WorkGoalTable.id, event.data.goalID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    yield* events.project(Work.Event.GoalPlacementReleased, (event) =>
      Effect.gen(function* () {
        const goal = yield* requireGoal(db, event.data.goalID)
        invariant(!WorkStateMachine.isGoalTerminal(goal.status), `Cannot release a terminal Goal in ${goal.status}`)
        invariant(goal.worker_id === event.data.workerID, "Goal placement release does not match its Worker")
        invariant(!event.data.reason || event.data.reason.length <= 4_000, "Goal placement reason is invalid")
        const lease = yield* db
          .select({ expiresAt: WorkLeaseTable.expires_at })
          .from(WorkLeaseTable)
          .where(eq(WorkLeaseTable.goal_id, event.data.goalID))
          .get()
          .pipe(Effect.orDie)
        invariant(
          !lease || lease.expiresAt <= DateTime.toEpochMillis(event.data.timestamp),
          "Cannot release a Goal while its ownership lease is active",
        )
        yield* db
          .update(WorkGoalTable)
          .set({
            worker_id: null,
            revision: revision(event),
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(WorkGoalTable.id, event.data.goalID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    yield* events.project(Work.Event.TaskCreated, (event) =>
      Effect.gen(function* () {
        const goal = yield* requireGoal(db, event.data.goalID)
        invariant(
          goal.status === "draft" || goal.status === "active" || goal.status === "paused",
          `Cannot add a Task to Goal in ${goal.status}`,
        )
        invariant(event.data.info.id !== (event.data.goalID as string), "Task ID must differ from Goal ID")
        invariant(event.data.info.goalID === event.data.goalID, "Task payload Goal ID does not match aggregate")
        invariant(event.data.info.status === "pending", "A new Task must start pending")
        invariant(
          event.data.info.role === "work-planner" ||
            WorkRole.get(event.data.info.role, roleContracts(goal)) !== undefined,
          `Unknown Work role ${event.data.info.role}`,
        )
        invariant(event.data.info.attemptCount === 0, "A new Task cannot start with attempts")
        invariant(event.data.info.revision === 0, "A new Task must start at revision zero")
        invariant(!event.data.info.dependsOn.includes(event.data.info.id), "A Task cannot depend on itself")
        invariant(
          new Set(event.data.info.dependsOn).size === event.data.info.dependsOn.length,
          "Task dependencies must be unique",
        )
        invariant(
          new Set(event.data.info.criteria).size === event.data.info.criteria.length,
          "Task criteria must be unique",
        )
        const criteria = new Set(goal.acceptance_criteria.map((criterion) => criterion.id))
        invariant(
          event.data.info.criteria.every((criterionID) => criteria.has(criterionID)),
          "Task criterion is unknown",
        )
        if (event.data.info.dependsOn.length > 0) {
          const dependencies = yield* db
            .select({ id: WorkTaskTable.id, goalID: WorkTaskTable.goal_id })
            .from(WorkTaskTable)
            .where(inArray(WorkTaskTable.id, Array.from(event.data.info.dependsOn)))
            .all()
            .pipe(Effect.orDie)
          invariant(dependencies.length === event.data.info.dependsOn.length, "Task dependency is unknown")
          invariant(
            dependencies.every((dependency) => dependency.goalID === event.data.goalID),
            "Cross-Goal dependency",
          )
        }
        const time = DateTime.toEpochMillis(event.data.timestamp)
        yield* db
          .insert(WorkTaskTable)
          .values({
            id: event.data.info.id,
            goal_id: event.data.goalID,
            title: event.data.info.title,
            instructions: event.data.info.instructions,
            depends_on: Array.from(event.data.info.dependsOn),
            role: event.data.info.role,
            directory: event.data.info.location?.directory,
            workspace_id: event.data.info.location?.workspaceID,
            status: "pending",
            criteria: Array.from(event.data.info.criteria),
            attempt_count: 0,
            revision: revision(event),
            time_created: time,
            time_updated: time,
          })
          .run()
          .pipe(Effect.orDie)
        yield* touchGoal(db, event)
      }),
    )

    yield* events.project(Work.Event.TaskGraphPlanned, (event) =>
      Effect.gen(function* () {
        const goal = yield* requireGoal(db, event.data.goalID)
        const planner = yield* requireTask(db, event.data.goalID, event.data.plannerTaskID)
        invariant(goal.status === "active", "A planned Task graph requires an active Goal")
        invariant(planner.role === "work-planner", "Task graph source is not a Planner Task")
        invariant(event.data.tasks.length > 0 && event.data.tasks.length <= 24, "Planned Task count is invalid")
        const ids = event.data.tasks.map((task) => task.id)
        const taskIDs = new Set(ids)
        invariant(taskIDs.size === ids.length, "Planned Task IDs must be unique")
        invariant(!taskIDs.has(event.data.plannerTaskID), "Planned graph cannot replace its Planner Task")
        const existing = yield* db
          .select({ id: WorkTaskTable.id })
          .from(WorkTaskTable)
          .where(eq(WorkTaskTable.goal_id, event.data.goalID))
          .all()
          .pipe(Effect.orDie)
        invariant(existing.length === 1 && existing[0]?.id === planner.id, "Goal already has an execution Task graph")
        const criteria = new Set(goal.acceptance_criteria.map((criterion) => criterion.id))
        for (const info of event.data.tasks) {
          invariant(
            WorkRole.get(info.role, roleContracts(goal)) !== undefined,
            `Unknown planned Work role ${info.role}`,
          )
          invariant(info.goalID === event.data.goalID, "Planned Task payload Goal ID does not match aggregate")
          invariant(info.status === "pending", "A planned Task must start pending")
          invariant(info.attemptCount === 0 && info.revision === 0, "A planned Task cannot contain runtime state")
          invariant(
            new Set(info.dependsOn).size === info.dependsOn.length &&
              info.dependsOn.every((dependencyID) => dependencyID !== info.id && taskIDs.has(dependencyID)),
            `Planned Task ${info.id} has invalid dependencies`,
          )
          invariant(
            new Set(info.criteria).size === info.criteria.length &&
              info.criteria.every((criterionID) => criteria.has(criterionID)),
            `Planned Task ${info.id} has invalid criteria`,
          )
        }
        invariant(acyclic(event.data.tasks), "Planned Task graph contains a dependency cycle")
        const assigned = new Set(event.data.tasks.flatMap((task) => task.criteria))
        invariant(
          goal.acceptance_criteria.every((criterion) => !criterion.required || assigned.has(criterion.id)),
          "Planned Task graph does not cover every required criterion",
        )
        const time = DateTime.toEpochMillis(event.data.timestamp)
        yield* db
          .insert(WorkTaskTable)
          .values(
            event.data.tasks.map((info) => ({
              id: info.id,
              goal_id: event.data.goalID,
              title: info.title,
              instructions: info.instructions,
              depends_on: Array.from(info.dependsOn),
              role: info.role,
              directory: info.location?.directory,
              workspace_id: info.location?.workspaceID,
              status: "pending" as const,
              criteria: Array.from(info.criteria),
              attempt_count: 0,
              revision: revision(event),
              time_created: time,
              time_updated: time,
            })),
          )
          .run()
          .pipe(Effect.orDie)
        yield* touchGoal(db, event)
      }),
    )

    yield* events.project(Work.Event.TaskGraphExpanded, (event) =>
      Effect.gen(function* () {
        const goal = yield* requireGoal(db, event.data.goalID)
        invariant(
          goal.status === "active" || goal.status === "paused",
          "Task graph expansion requires an active or paused Goal",
        )
        invariant(event.data.tasks.length > 0 && event.data.tasks.length <= 24, "Expanded Task count is invalid")
        const existing = yield* db
          .select({ id: WorkTaskTable.id, dependsOn: WorkTaskTable.depends_on })
          .from(WorkTaskTable)
          .where(eq(WorkTaskTable.goal_id, event.data.goalID))
          .all()
          .pipe(Effect.orDie)
        invariant(existing.length + event.data.tasks.length <= 128, "Expanded graph exceeds the Task limit")
        const existingIDs = new Set(existing.map((task) => task.id))
        const ids = event.data.tasks.map((task) => task.id)
        const addedIDs = new Set(ids)
        invariant(addedIDs.size === ids.length, "Expanded Task IDs must be unique")
        invariant(
          ids.every((taskID) => !existingIDs.has(taskID)),
          "Expanded Task ID already exists",
        )
        const knownIDs = new Set([...existingIDs, ...addedIDs])
        const criteria = new Set(goal.acceptance_criteria.map((criterion) => criterion.id))
        for (const info of event.data.tasks) {
          invariant(
            WorkRole.get(info.role, roleContracts(goal)) !== undefined,
            `Unknown expanded Work role ${info.role}`,
          )
          invariant(info.goalID === event.data.goalID, "Expanded Task payload Goal ID does not match aggregate")
          invariant(info.status === "pending", "An expanded Task must start pending")
          invariant(info.attemptCount === 0 && info.revision === 0, "An expanded Task cannot contain runtime state")
          invariant(
            new Set(info.dependsOn).size === info.dependsOn.length &&
              info.dependsOn.every((dependencyID) => dependencyID !== info.id && knownIDs.has(dependencyID)),
            `Expanded Task ${info.id} has invalid dependencies`,
          )
          invariant(
            new Set(info.criteria).size === info.criteria.length &&
              info.criteria.every((criterionID) => criteria.has(criterionID)),
            `Expanded Task ${info.id} has invalid criteria`,
          )
        }
        invariant(acyclic([...existing, ...event.data.tasks]), "Expanded Task graph contains a dependency cycle")
        const time = DateTime.toEpochMillis(event.data.timestamp)
        yield* db
          .insert(WorkTaskTable)
          .values(
            event.data.tasks.map((info) => ({
              id: info.id,
              goal_id: event.data.goalID,
              title: info.title,
              instructions: info.instructions,
              depends_on: Array.from(info.dependsOn),
              role: info.role,
              directory: info.location?.directory,
              workspace_id: info.location?.workspaceID,
              status: "pending" as const,
              criteria: Array.from(info.criteria),
              attempt_count: 0,
              revision: revision(event),
              time_created: time,
              time_updated: time,
            })),
          )
          .run()
          .pipe(Effect.orDie)
        yield* touchGoal(db, event)
      }),
    )

    yield* events.project(Work.Event.TaskGraphReplanned, (event) =>
      Effect.gen(function* () {
        const goal = yield* requireGoal(db, event.data.goalID)
        const architect = yield* requireTask(db, event.data.goalID, event.data.architectTaskID)
        invariant(goal.status === "active", "A replanned Task graph requires an active Goal")
        invariant(architect.role === "work-architect", "Task graph source is not an Architect Task")
        invariant(architect.status === "running", "Architect Task must be running while its graph is committed")
        invariant(event.data.tasks.length > 0 && event.data.tasks.length <= 24, "Replanned Task count is invalid")
        const existing = yield* db
          .select({
            id: WorkTaskTable.id,
            dependsOn: WorkTaskTable.depends_on,
            status: WorkTaskTable.status,
            criteria: WorkTaskTable.criteria,
            role: WorkTaskTable.role,
          })
          .from(WorkTaskTable)
          .where(eq(WorkTaskTable.goal_id, event.data.goalID))
          .all()
          .pipe(Effect.orDie)
        invariant(existing.length + event.data.tasks.length <= 128, "Replanned graph exceeds the Task limit")
        const existingByID = new Map(existing.map((task) => [task.id, task]))
        const supersededIDs = new Set(event.data.supersededTaskIDs)
        invariant(supersededIDs.size === event.data.supersededTaskIDs.length, "Superseded Task IDs must be unique")
        invariant(
          event.data.supersededTaskIDs.every((taskID) => {
            const task = existingByID.get(taskID)
            return task?.status === "blocked"
          }),
          "Only blocked Tasks can be superseded",
        )
        const blocked = existing.filter((task) => task.status === "blocked")
        invariant(
          blocked.length === supersededIDs.size && blocked.every((task) => supersededIDs.has(task.id)),
          "A replan must supersede every blocked Task",
        )
        const ids = event.data.tasks.map((task) => task.id)
        const addedIDs = new Set(ids)
        invariant(addedIDs.size === ids.length, "Replanned Task IDs must be unique")
        invariant(
          ids.every((taskID) => !existingByID.has(taskID)),
          "Replanned Task ID already exists",
        )
        const knownIDs = new Set([...existingByID.keys(), ...addedIDs])
        const criteria = new Set(goal.acceptance_criteria.map((criterion) => criterion.id))
        for (const info of event.data.tasks) {
          invariant(
            WorkRole.get(info.role, roleContracts(goal)) !== undefined,
            `Unknown replacement Work role ${info.role}`,
          )
          invariant(info.goalID === event.data.goalID, "Replanned Task payload Goal ID does not match aggregate")
          invariant(info.status === "pending", "A replanned Task must start pending")
          invariant(info.attemptCount === 0 && info.revision === 0, "A replanned Task cannot contain runtime state")
          invariant(
            info.role !== "work-planner" && info.role !== "work-architect",
            `Replanned Task ${info.id} uses a reserved runtime role`,
          )
          invariant(
            new Set(info.dependsOn).size === info.dependsOn.length &&
              info.dependsOn.every((dependencyID) => dependencyID !== info.id && knownIDs.has(dependencyID)),
            `Replanned Task ${info.id} has invalid dependencies`,
          )
          invariant(
            new Set(info.criteria).size === info.criteria.length &&
              info.criteria.every((criterionID) => criteria.has(criterionID)),
            `Replanned Task ${info.id} has invalid criteria`,
          )
        }
        invariant(acyclic([...existing, ...event.data.tasks]), "Replanned Task graph contains a dependency cycle")
        const reassigned = new Set(event.data.tasks.flatMap((task) => task.criteria))
        invariant(
          event.data.supersededTaskIDs
            .flatMap((taskID) => existingByID.get(taskID)?.criteria ?? [])
            .every((criterionID) => reassigned.has(criterionID)),
          "Replanned Task graph does not preserve superseded criteria",
        )
        const effectiveCriteria = new Set([
          ...existing.filter((task) => !supersededIDs.has(task.id)).flatMap((task) => task.criteria),
          ...event.data.tasks.flatMap((task) => task.criteria),
        ])
        invariant(
          goal.acceptance_criteria.every((criterion) => !criterion.required || effectiveCriteria.has(criterion.id)),
          "Replanned Task graph does not cover every required criterion",
        )
        const time = DateTime.toEpochMillis(event.data.timestamp)
        if (event.data.supersededTaskIDs.length > 0)
          yield* db
            .update(WorkTaskTable)
            .set({ status: "superseded", revision: revision(event), time_updated: time, time_completed: time })
            .where(inArray(WorkTaskTable.id, event.data.supersededTaskIDs))
            .run()
            .pipe(Effect.orDie)
        yield* db
          .insert(WorkTaskTable)
          .values(
            event.data.tasks.map((info) => ({
              id: info.id,
              goal_id: event.data.goalID,
              title: info.title,
              instructions: info.instructions,
              depends_on: Array.from(info.dependsOn),
              role: info.role,
              directory: info.location?.directory,
              workspace_id: info.location?.workspaceID,
              status: "pending" as const,
              criteria: Array.from(info.criteria),
              attempt_count: 0,
              revision: revision(event),
              time_created: time,
              time_updated: time,
            })),
          )
          .run()
          .pipe(Effect.orDie)
        yield* touchGoal(db, event)
      }),
    )

    yield* events.project(Work.Event.TaskReadied, (event) =>
      Effect.gen(function* () {
        const task = yield* requireTask(db, event.data.goalID, event.data.taskID)
        if (task.depends_on.length > 0) {
          const dependencies = yield* db
            .select({ id: WorkTaskTable.id, status: WorkTaskTable.status, role: WorkTaskTable.role })
            .from(WorkTaskTable)
            .where(inArray(WorkTaskTable.id, task.depends_on))
            .all()
            .pipe(Effect.orDie)
          invariant(
            dependencies.length === task.depends_on.length &&
              dependencies.every(
                (dependency) => dependency.status === "completed" || dependency.status === "superseded",
              ),
            "Task dependencies are not complete",
          )
          const requiredHandoffs = dependencies.filter(
            (dependency) =>
              dependency.status === "completed" &&
              dependency.role !== "work-planner" &&
              dependency.role !== "work-architect",
          )
          if (requiredHandoffs.length > 0) {
            const handoffs = yield* db
              .select({ taskID: WorkHandoffTable.task_id, recipients: WorkHandoffTable.recipients })
              .from(WorkHandoffTable)
              .where(
                inArray(
                  WorkHandoffTable.task_id,
                  requiredHandoffs.map((dependency) => dependency.id),
                ),
              )
              .all()
              .pipe(Effect.orDie)
            invariant(
              requiredHandoffs.every((dependency) =>
                handoffs.some((handoff) => handoff.taskID === dependency.id && handoff.recipients.includes(task.id)),
              ),
              "Task dependencies have not delivered their Handoffs",
            )
          }
        }
        yield* projectTaskStatus(db, event)
      }),
    )
    yield* events.project(Work.Event.TaskStarted, (event) => projectTaskStatus(db, event))
    yield* events.project(Work.Event.TaskVerificationStarted, (event) => projectTaskStatus(db, event))
    yield* events.project(Work.Event.TaskReviewStarted, (event) => projectTaskStatus(db, event))
    yield* events.project(Work.Event.TaskMergeStarted, (event) => {
      invariant(
        (event.data.changes === undefined) !== (event.data.artifact === undefined),
        "Merge input must be inline or external",
      )
      invariant(
        event.data.artifact === undefined || event.data.artifact.digest === event.data.digest,
        "Merge artifact digest does not match merge input",
      )
      return projectTaskStatus(db, event)
    })
    yield* events.project(Work.Event.TaskMerged, (event) => projectTaskStatus(db, event))
    yield* events.project(Work.Event.TaskMergeConflicted, (event) => projectTaskStatus(db, event))
    yield* events.project(Work.Event.TaskIsolationArchived, (event) =>
      Effect.gen(function* () {
        const goal = yield* requireGoal(db, event.data.goalID)
        const task = yield* requireTask(db, event.data.goalID, event.data.taskID)
        invariant(
          (event.data.reason === "cancelled" && goal.status === "cancelling" && task.status === "cancelled") ||
            (event.data.reason === "superseded" && goal.status === "active" && task.status === "blocked"),
          "Isolation archival does not match the Goal and Task state",
        )
        invariant(event.data.artifact.digest.length === 64, "Isolation archive digest is invalid")
        yield* touchGoal(db, event)
      }),
    )
    yield* events.project(Work.Event.TaskReworkRequested, (event) => projectTaskStatus(db, event))
    yield* events.project(Work.Event.TaskCompleted, (event) => projectTaskStatus(db, event))
    yield* events.project(Work.Event.TaskBlocked, (event) => projectTaskStatus(db, event))
    yield* events.project(Work.Event.TaskCancelled, (event) => projectTaskStatus(db, event))

    yield* events.project(Work.Event.AttemptAdmitted, (event) =>
      Effect.gen(function* () {
        const goal = yield* requireGoal(db, event.data.goalID)
        const task = yield* requireTask(db, event.data.goalID, event.data.info.taskID)
        invariant(goal.status === "active", "Attempts require an active Goal")
        invariant(
          task.status === "running" || (task.status === "reviewing" && event.data.info.kind === "review"),
          "Attempts require a running Task or a reviewing Task with review kind",
        )
        invariant(event.data.info.id !== (event.data.info.taskID as string), "Attempt ID must differ from Task ID")
        invariant(event.data.info.goalID === event.data.goalID, "Attempt payload Goal ID does not match aggregate")
        invariant(event.data.info.status === "admitted", "A new Attempt must start admitted")
        invariant(event.data.info.number === task.attempt_count + 1, "Attempt number must be monotonic")
        invariant(event.data.info.inputRevision === task.revision, "Attempt input revision is stale")
        const time = DateTime.toEpochMillis(event.data.timestamp)
        yield* db
          .insert(WorkAttemptTable)
          .values({
            id: event.data.info.id,
            goal_id: event.data.goalID,
            task_id: event.data.info.taskID,
            kind: event.data.info.kind,
            number: event.data.info.number,
            session_id: event.data.info.sessionID,
            status: "admitted",
            input_revision: event.data.info.inputRevision,
            time_created: time,
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(WorkTaskTable)
          .set({ attempt_count: event.data.info.number, revision: revision(event), time_updated: time })
          .where(eq(WorkTaskTable.id, task.id))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(WorkGoalTable)
          .set({
            usage: {
              ...goal.usage,
              attempts: goal.usage.attempts + 1,
              repairs: goal.usage.repairs + (event.data.info.kind === "repair" ? 1 : 0),
            },
            revision: revision(event),
            time_updated: time,
          })
          .where(eq(WorkGoalTable.id, event.data.goalID))
          .run()
          .pipe(Effect.orDie)
      }),
    )

    yield* events.project(Work.Event.AttemptStarted, (event) =>
      Effect.gen(function* () {
        const attempt = yield* requireAttempt(db, event.data.goalID, event.data.attemptID)
        WorkStateMachine.attempt(attempt.status, "running")
        const time = DateTime.toEpochMillis(event.data.timestamp)
        yield* db
          .update(WorkAttemptTable)
          .set({ status: "running", owner_id: event.data.ownerID, fence: event.data.fence, time_started: time })
          .where(eq(WorkAttemptTable.id, event.data.attemptID))
          .run()
          .pipe(Effect.orDie)
        yield* touchTaskAndGoal(db, attempt.task_id, event)
      }),
    )

    yield* events.project(Work.Event.AttemptSettled, (event) =>
      Effect.gen(function* () {
        const attempt = yield* requireAttempt(db, event.data.goalID, event.data.attemptID)
        invariant(
          WorkStateMachine.isAttemptTerminal(event.data.status),
          "Attempt settlement requires a terminal status",
        )
        WorkStateMachine.attempt(attempt.status, event.data.status)
        invariant(
          event.data.status === "succeeded" ? event.data.failure === undefined : event.data.failure !== undefined,
          "Attempt failure details do not match the settlement status",
        )
        if (attempt.status === "running") {
          invariant(event.data.ownerID === attempt.owner_id, "Attempt settlement owner is stale")
          invariant(event.data.fence === attempt.fence, "Attempt settlement fence is stale")
        }
        yield* db
          .update(WorkAttemptTable)
          .set({
            status: event.data.status,
            failure: event.data.failure,
            time_ended: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(WorkAttemptTable.id, event.data.attemptID))
          .run()
          .pipe(Effect.orDie)
        if (attempt.session_id) {
          const session = yield* db
            .select({ cost: SessionTable.cost })
            .from(SessionTable)
            .where(eq(SessionTable.id, attempt.session_id))
            .get()
            .pipe(Effect.orDie)
          const turns = yield* db
            .select({ value: count(SessionMessageTable.id) })
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, attempt.session_id), eq(SessionMessageTable.type, "assistant")))
            .get()
            .pipe(Effect.orDie)
          const goal = yield* requireGoal(db, event.data.goalID)
          yield* db
            .update(WorkGoalTable)
            .set({
              usage: {
                ...goal.usage,
                turns: goal.usage.turns + (turns?.value ?? 0),
                cost: goal.usage.cost + (session?.cost ?? 0),
              },
            })
            .where(eq(WorkGoalTable.id, event.data.goalID))
            .run()
            .pipe(Effect.orDie)
        }
        yield* touchTaskAndGoal(db, attempt.task_id, event)
      }),
    )

    yield* events.project(Work.Event.EvidenceRecorded, (event) =>
      Effect.gen(function* () {
        const info = event.data.info
        const task = yield* requireTask(db, event.data.goalID, info.taskID)
        const attempt = yield* requireAttempt(db, event.data.goalID, info.attemptID)
        invariant(info.goalID === event.data.goalID, "Evidence payload Goal ID does not match aggregate")
        invariant(attempt.task_id === info.taskID, "Evidence Attempt does not belong to Task")
        invariant(info.criterionIDs.length > 0, "Evidence must address at least one criterion")
        invariant(
          info.criterionIDs.every((criterionID) => task.criteria.includes(criterionID)),
          "Evidence criterion does not belong to Task",
        )
        yield* db
          .insert(WorkEvidenceTable)
          .values({
            id: info.id,
            goal_id: event.data.goalID,
            task_id: info.taskID,
            attempt_id: info.attemptID,
            criterion_ids: Array.from(info.criterionIDs),
            kind: info.kind,
            producer: info.producer,
            payload: info.payload,
            digest: info.digest,
            reference: info.reference,
            time_created: DateTime.toEpochMillis(info.createdAt),
          })
          .run()
          .pipe(Effect.orDie)
        yield* touchTaskAndGoal(db, info.taskID, event)
      }),
    )

    yield* events.project(Work.Event.EvaluationRecorded, (event) =>
      Effect.gen(function* () {
        const info = event.data.info
        const task = yield* requireTask(db, event.data.goalID, info.taskID)
        const attempt = yield* requireAttempt(db, event.data.goalID, info.attemptID)
        invariant(info.goalID === event.data.goalID, "Evaluation payload Goal ID does not match aggregate")
        invariant(attempt.task_id === info.taskID, "Evaluation Attempt does not belong to Task")
        invariant(task.criteria.includes(info.criterionID), "Evaluation criterion does not belong to Task")
        if (info.evidenceIDs.length > 0) {
          const evidence = yield* db
            .select({ id: WorkEvidenceTable.id, attemptID: WorkEvidenceTable.attempt_id })
            .from(WorkEvidenceTable)
            .where(inArray(WorkEvidenceTable.id, Array.from(info.evidenceIDs)))
            .all()
            .pipe(Effect.orDie)
          invariant(evidence.length === info.evidenceIDs.length, "Evaluation evidence is unknown")
          invariant(
            evidence.every((item) => item.attemptID === info.attemptID),
            "Evaluation evidence is cross-Attempt",
          )
        }
        invariant(info.verdict !== "pass" || info.evidenceIDs.length > 0, "Passing Evaluation requires evidence")
        yield* db
          .insert(WorkEvaluationTable)
          .values({
            id: info.id,
            goal_id: event.data.goalID,
            task_id: info.taskID,
            attempt_id: info.attemptID,
            criterion_id: info.criterionID,
            evidence_ids: Array.from(info.evidenceIDs),
            verdict: info.verdict,
            evaluator: info.evaluator,
            evaluator_version: info.evaluatorVersion,
            findings: Array.from(info.findings),
            allows_repair: info.allowsRepair,
            time_created: DateTime.toEpochMillis(info.createdAt),
          })
          .run()
          .pipe(Effect.orDie)
        yield* touchTaskAndGoal(db, info.taskID, event)
      }),
    )

    yield* events.project(Work.Event.TaskHandoffRecorded, (event) =>
      Effect.gen(function* () {
        const info = event.data.info
        const goal = yield* requireGoal(db, event.data.goalID)
        const task = yield* requireTask(db, event.data.goalID, info.taskID)
        const attempt = yield* requireAttempt(db, event.data.goalID, info.attemptID)
        invariant(info.goalID === event.data.goalID, "Handoff payload Goal ID does not match aggregate")
        invariant(task.status === "completed", "Handoff requires a completed Task")
        invariant(
          task.role !== "work-planner" && task.role !== "work-architect",
          "Internal Tasks cannot publish Handoffs",
        )
        invariant(attempt.task_id === info.taskID, "Handoff Attempt does not belong to Task")
        invariant(attempt.status === "succeeded", "Handoff requires a successful Attempt")
        invariant(info.producer === task.role, "Handoff producer does not match Task role")
        const contract = WorkRole.get(task.role, roleContracts(goal))
        invariant(contract !== undefined, "Handoff producer has no Role Contract")
        invariant(info.summary.trim().length > 0 && info.summary.length <= 12_000, "Handoff summary is invalid")
        invariant(info.items.length > 0 && info.items.length <= 64, "Handoff items are invalid")
        invariant(
          info.items.every((item) => item.text.trim().length > 0 && item.text.length <= 4_000),
          "Handoff item text is invalid",
        )
        invariant(
          info.items.every((item) => contract.publishes.includes(item.kind)),
          "Handoff item is not allowed by the producer Role Contract",
        )
        invariant(
          info.items.every((item) => item.memory !== "project" || !!item.key?.trim()),
          "Project-memory Handoff items require a stable key",
        )
        invariant(new Set(info.evidenceIDs).size === info.evidenceIDs.length, "Handoff evidence must be unique")
        invariant(new Set(info.recipients).size === info.recipients.length, "Handoff recipients must be unique")
        if (info.evidenceIDs.length > 0) {
          const evidence = yield* db
            .select({ id: WorkEvidenceTable.id, taskID: WorkEvidenceTable.task_id })
            .from(WorkEvidenceTable)
            .where(inArray(WorkEvidenceTable.id, Array.from(info.evidenceIDs)))
            .all()
            .pipe(Effect.orDie)
          invariant(evidence.length === info.evidenceIDs.length, "Handoff evidence is unknown")
          invariant(
            evidence.every((item) => item.taskID === info.taskID),
            "Handoff evidence is cross-Task",
          )
        }
        if (info.recipients.length > 0) {
          const recipients = yield* db
            .select({ id: WorkTaskTable.id, goalID: WorkTaskTable.goal_id, dependsOn: WorkTaskTable.depends_on })
            .from(WorkTaskTable)
            .where(inArray(WorkTaskTable.id, Array.from(info.recipients)))
            .all()
            .pipe(Effect.orDie)
          invariant(recipients.length === info.recipients.length, "Handoff recipient is unknown")
          invariant(
            recipients.every(
              (recipient) => recipient.goalID === event.data.goalID && recipient.dependsOn.includes(info.taskID),
            ),
            "Handoff recipient is not a direct downstream Task",
          )
        }
        invariant(
          info.digest === handoffDigest(info.summary, info.items, info.evidenceIDs),
          "Handoff digest does not match content",
        )
        invariant(
          DateTime.toEpochMillis(info.createdAt) === DateTime.toEpochMillis(event.data.timestamp),
          "Handoff timestamp does not match event",
        )
        yield* db
          .insert(WorkHandoffTable)
          .values({
            id: info.id,
            goal_id: event.data.goalID,
            task_id: info.taskID,
            attempt_id: info.attemptID,
            producer: info.producer,
            summary: info.summary,
            items: Array.from(info.items),
            evidence_ids: Array.from(info.evidenceIDs),
            recipients: Array.from(info.recipients),
            digest: info.digest,
            time_created: DateTime.toEpochMillis(info.createdAt),
          })
          .run()
          .pipe(Effect.orDie)
        yield* touchGoal(db, event)
      }),
    )

    yield* events.project(Work.Event.TaskHandoffRouted, (event) =>
      Effect.gen(function* () {
        invariant(event.data.recipientTaskIDs.length > 0, "Handoff routing requires at least one recipient")
        invariant(
          new Set(event.data.recipientTaskIDs).size === event.data.recipientTaskIDs.length,
          "Handoff routing recipients must be unique",
        )
        const handoff = yield* requireHandoff(db, event.data.goalID, event.data.handoffID)
        invariant(
          event.data.recipientTaskIDs.every((taskID) => !handoff.recipients.includes(taskID)),
          "Handoff recipient is already routed",
        )
        const recipients = yield* db
          .select({ id: WorkTaskTable.id, goalID: WorkTaskTable.goal_id, dependsOn: WorkTaskTable.depends_on })
          .from(WorkTaskTable)
          .where(inArray(WorkTaskTable.id, Array.from(event.data.recipientTaskIDs)))
          .all()
          .pipe(Effect.orDie)
        invariant(recipients.length === event.data.recipientTaskIDs.length, "Handoff routing recipient is unknown")
        invariant(
          recipients.every(
            (recipient) => recipient.goalID === event.data.goalID && recipient.dependsOn.includes(handoff.task_id),
          ),
          "Handoff can only route to direct downstream Tasks",
        )
        yield* db
          .update(WorkHandoffTable)
          .set({ recipients: [...handoff.recipients, ...event.data.recipientTaskIDs] })
          .where(eq(WorkHandoffTable.id, event.data.handoffID))
          .run()
          .pipe(Effect.orDie)
        yield* touchGoal(db, event)
      }),
    )

    yield* events.project(Work.Event.ProjectMemoryResolved, (event) =>
      Effect.gen(function* () {
        const info = event.data.info
        const goal = yield* requireGoal(db, event.data.goalID)
        invariant(info.goalID === event.data.goalID, "Memory resolution Goal ID does not match aggregate")
        invariant(
          info.location.directory === goal.directory && info.location.workspaceID === (goal.workspace_id ?? undefined),
          "Memory resolution location does not match Goal",
        )
        invariant(info.key.trim().length > 0 && info.key.length <= 200, "Memory resolution key is invalid")
        invariant(info.resolver.trim().length > 0 && info.resolver.length <= 200, "Memory resolver is invalid")
        invariant(!info.reason || info.reason.length <= 4_000, "Memory resolution reason is invalid")
        const handoff = yield* db
          .select()
          .from(WorkHandoffTable)
          .where(eq(WorkHandoffTable.id, info.handoffID))
          .get()
          .pipe(Effect.orDie)
        invariant(handoff !== undefined, `Unknown Handoff ${info.handoffID}`)
        const source = yield* requireGoal(db, handoff.goal_id)
        invariant(
          source.directory === goal.directory && source.workspace_id === goal.workspace_id,
          "Memory resolution cannot select a cross-project Handoff",
        )
        invariant(handoff.digest === info.handoffDigest, "Memory resolution Handoff digest does not match")
        const item = handoff.items.find(
          (candidate) => candidate.key === info.key && WorkHandoff.itemDigest(candidate) === info.itemDigest,
        )
        invariant(item !== undefined, "Memory resolution item does not match Handoff content")
        invariant(item.memory === "project", "Memory resolution requires a project-memory item")
        invariant(item.kind !== "next_action", "Memory resolution cannot select a next action")
        invariant(
          !item.expiresAt || DateTime.toEpochMillis(item.expiresAt) > DateTime.toEpochMillis(event.data.timestamp),
          "Memory resolution cannot select an expired item",
        )
        invariant(info.action !== "replace" || info.value !== undefined, "Memory replacement requires a value")
        invariant(info.action === "replace" || info.value === undefined, "Only memory replacement may carry a value")
        if (info.value) {
          invariant(info.value.memory === "project", "Memory replacement must retain project scope")
          invariant(info.value.key === info.key, "Memory replacement key does not match")
          invariant(info.value.kind !== "next_action", "Memory replacement cannot be a next action")
          invariant(info.value.text.trim().length > 0 && info.value.text.length <= 12_000, "Memory replacement is invalid")
        }
        invariant(
          DateTime.toEpochMillis(info.createdAt) === DateTime.toEpochMillis(event.data.timestamp),
          "Memory resolution timestamp does not match event",
        )
        yield* db
          .insert(WorkMemoryResolutionTable)
          .values({
            id: info.id,
            goal_id: info.goalID,
            directory: info.location.directory,
            workspace_id: info.location.workspaceID,
            key: info.key,
            handoff_id: info.handoffID,
            handoff_digest: info.handoffDigest,
            item_digest: info.itemDigest,
            action: info.action,
            value: info.value,
            resolver: info.resolver,
            reason: info.reason,
            time_created: DateTime.toEpochMillis(info.createdAt),
          })
          .run()
          .pipe(Effect.orDie)
        yield* touchGoal(db, event)
      }),
    )
  }),
)

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProjectionError(message)
}

function handoffDigest(
  summary: string,
  items: ReadonlyArray<Work.HandoffItem>,
  evidenceIDs: ReadonlyArray<Work.EvidenceID>,
) {
  return Hash.sha256(JSON.stringify({ summary, items, evidenceIDs }))
}

function acyclic(tasks: ReadonlyArray<{ readonly id: Work.TaskID; readonly dependsOn: ReadonlyArray<Work.TaskID> }>) {
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn)]))
  while (remaining.size > 0) {
    const ready = Array.from(remaining).filter(([, dependencies]) => dependencies.size === 0)
    if (ready.length === 0) return false
    for (const [taskID] of ready) remaining.delete(taskID)
    for (const dependencies of remaining.values()) for (const [taskID] of ready) dependencies.delete(taskID)
  }
  return true
}

function revision(event: DurablePayload) {
  invariant(event.durable !== undefined, "Work projector requires a durable event")
  return event.durable.seq
}

function requireGoal(db: DatabaseClient, goalID: Work.GoalID) {
  return Effect.gen(function* () {
    const row = yield* db.select().from(WorkGoalTable).where(eq(WorkGoalTable.id, goalID)).get().pipe(Effect.orDie)
    invariant(row !== undefined, `Unknown Goal ${goalID}`)
    return row
  })
}

function requireTask(db: DatabaseClient, goalID: Work.GoalID, taskID: Work.TaskID) {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(WorkTaskTable)
      .where(and(eq(WorkTaskTable.id, taskID), eq(WorkTaskTable.goal_id, goalID)))
      .get()
      .pipe(Effect.orDie)
    invariant(row !== undefined, `Unknown Task ${taskID} in Goal ${goalID}`)
    return row
  })
}

function requireAttempt(db: DatabaseClient, goalID: Work.GoalID, attemptID: Work.AttemptID) {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(WorkAttemptTable)
      .where(and(eq(WorkAttemptTable.id, attemptID), eq(WorkAttemptTable.goal_id, goalID)))
      .get()
      .pipe(Effect.orDie)
    invariant(row !== undefined, `Unknown Attempt ${attemptID} in Goal ${goalID}`)
    return row
  })
}

function requireHandoff(db: DatabaseClient, goalID: Work.GoalID, handoffID: Work.HandoffID) {
  return Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(WorkHandoffTable)
      .where(and(eq(WorkHandoffTable.id, handoffID), eq(WorkHandoffTable.goal_id, goalID)))
      .get()
      .pipe(Effect.orDie)
    invariant(row !== undefined, `Unknown Handoff ${handoffID} in Goal ${goalID}`)
    return row
  })
}

function projectGoalStatus(
  db: DatabaseClient,
  event: DurablePayload & { readonly data: { readonly goalID: Work.GoalID; readonly timestamp: DateTime.Utc } },
  status: Work.GoalStatus,
) {
  return Effect.gen(function* () {
    const row = yield* requireGoal(db, event.data.goalID)
    WorkStateMachine.goal(row.status, status)
    const time = DateTime.toEpochMillis(event.data.timestamp)
    yield* db
      .update(WorkGoalTable)
      .set({
        status,
        revision: revision(event),
        time_updated: time,
        time_completed: WorkStateMachine.isGoalTerminal(status) ? time : null,
      })
      .where(eq(WorkGoalTable.id, event.data.goalID))
      .run()
      .pipe(Effect.orDie)
  })
}

function projectTaskStatus(db: DatabaseClient, event: TaskTransition) {
  return Effect.gen(function* () {
    const row = yield* requireTask(db, event.data.goalID, event.data.taskID)
    WorkStateMachine.task(row.status, event.data.status)
    const time = DateTime.toEpochMillis(event.data.timestamp)
    yield* db
      .update(WorkTaskTable)
      .set({
        status: event.data.status,
        revision: revision(event),
        time_updated: time,
        time_completed: WorkStateMachine.isTaskTerminal(event.data.status) ? time : null,
      })
      .where(eq(WorkTaskTable.id, event.data.taskID))
      .run()
      .pipe(Effect.orDie)
    yield* touchGoal(db, event)
  })
}

function touchGoal(
  db: DatabaseClient,
  event: DurablePayload & { readonly data: { readonly goalID: Work.GoalID; readonly timestamp: DateTime.Utc } },
) {
  return db
    .update(WorkGoalTable)
    .set({ revision: revision(event), time_updated: DateTime.toEpochMillis(event.data.timestamp) })
    .where(eq(WorkGoalTable.id, event.data.goalID))
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
}

function touchTaskAndGoal(
  db: DatabaseClient,
  taskID: Work.TaskID,
  event: DurablePayload & { readonly data: { readonly goalID: Work.GoalID; readonly timestamp: DateTime.Utc } },
) {
  const time = DateTime.toEpochMillis(event.data.timestamp)
  return Effect.all(
    [
      db
        .update(WorkTaskTable)
        .set({ revision: revision(event), time_updated: time })
        .where(eq(WorkTaskTable.id, taskID))
        .run()
        .pipe(Effect.orDie),
      db
        .update(WorkGoalTable)
        .set({ revision: revision(event), time_updated: time })
        .where(eq(WorkGoalTable.id, event.data.goalID))
        .run()
        .pipe(Effect.orDie),
    ],
    { discard: true },
  )
}

function assertCompletable(db: DatabaseClient, goalID: Work.GoalID) {
  return Effect.gen(function* () {
    const goal = yield* requireGoal(db, goalID)
    const tasks = yield* db
      .select({ id: WorkTaskTable.id, status: WorkTaskTable.status })
      .from(WorkTaskTable)
      .where(eq(WorkTaskTable.goal_id, goalID))
      .all()
      .pipe(Effect.orDie)
    invariant(tasks.length > 0, "Goal completion requires at least one Task")
    invariant(
      tasks.every((task) => task.status === "completed" || task.status === "superseded"),
      "Goal has incomplete Tasks",
    )

    const required = goal.acceptance_criteria.filter((criterion) => criterion.required)
    if (required.length === 0) return
    const completedTaskIDs = tasks.filter((task) => task.status === "completed").map((task) => task.id)
    invariant(completedTaskIDs.length > 0, "Goal criteria require a completed Task")
    const evaluations = yield* db
      .select({ criterionID: WorkEvaluationTable.criterion_id, verdict: WorkEvaluationTable.verdict })
      .from(WorkEvaluationTable)
      .where(and(eq(WorkEvaluationTable.goal_id, goalID), inArray(WorkEvaluationTable.task_id, completedTaskIDs)))
      .orderBy(asc(WorkEvaluationTable.time_created), asc(WorkEvaluationTable.id))
      .all()
      .pipe(Effect.orDie)
    const latest = new Map(evaluations.map((evaluation) => [evaluation.criterionID, evaluation.verdict]))
    invariant(
      required.every((criterion) => latest.get(criterion.id) === "pass"),
      "Goal has unmet criteria",
    )
  })
}

function roleContracts(goal: typeof WorkGoalTable.$inferSelect) {
  return goal.role_contracts.length > 0 ? goal.role_contracts : WorkRole.contracts
}

export const node = makeGlobalNode({ name: "work-projector", layer, deps: [EventV2.node, Database.node] })
