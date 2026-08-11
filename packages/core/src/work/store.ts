export * as WorkStore from "./store"

import { Work } from "@zaovra-ai/schema/work"
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { WorkInfo } from "./info"
import {
  WorkAttemptTable,
  WorkEvaluationTable,
  WorkEvidenceTable,
  WorkGoalTable,
  WorkHandoffTable,
  WorkMemoryResolutionTable,
  WorkTaskTable,
} from "./sql"

export interface Interface {
  readonly goals: (statuses?: ReadonlyArray<Work.GoalStatus>) => Effect.Effect<Work.GoalInfo[]>
  readonly getGoal: (goalID: Work.GoalID) => Effect.Effect<Work.GoalInfo | undefined>
  readonly getTask: (taskID: Work.TaskID) => Effect.Effect<Work.TaskInfo | undefined>
  readonly tasks: (goalID: Work.GoalID) => Effect.Effect<Work.TaskInfo[]>
  readonly getAttempt: (attemptID: Work.AttemptID) => Effect.Effect<Work.AttemptInfo | undefined>
  readonly attempts: (taskID: Work.TaskID) => Effect.Effect<Work.AttemptInfo[]>
  readonly evidence: (taskID: Work.TaskID) => Effect.Effect<Work.EvidenceInfo[]>
  readonly evaluations: (taskID: Work.TaskID) => Effect.Effect<Work.EvaluationInfo[]>
  readonly handoff: (taskID: Work.TaskID) => Effect.Effect<Work.HandoffInfo | undefined>
  readonly handoffs: (goalID: Work.GoalID) => Effect.Effect<Work.HandoffInfo[]>
  readonly mailbox: (taskID: Work.TaskID) => Effect.Effect<Work.HandoffInfo[]>
  readonly projectHandoffs: (location: Work.GoalInfo["location"], limit?: number) => Effect.Effect<Work.HandoffInfo[]>
  readonly projectMemoryResolutions: (
    location: Work.GoalInfo["location"],
    limit?: number,
  ) => Effect.Effect<Work.MemoryResolutionInfo[]>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    return Service.of({
      goals: Effect.fn("WorkStore.goals")(function* (statuses) {
        const query = db.select().from(WorkGoalTable)
        return (yield* (
          statuses && statuses.length > 0 ? query.where(inArray(WorkGoalTable.status, Array.from(statuses))) : query
        )
          .orderBy(asc(WorkGoalTable.time_created), asc(WorkGoalTable.id))
          .all()
          .pipe(Effect.orDie)).map(WorkInfo.goal)
      }),
      getGoal: Effect.fn("WorkStore.getGoal")(function* (goalID) {
        const row = yield* db.select().from(WorkGoalTable).where(eq(WorkGoalTable.id, goalID)).get().pipe(Effect.orDie)
        return row ? WorkInfo.goal(row) : undefined
      }),
      getTask: Effect.fn("WorkStore.getTask")(function* (taskID) {
        const row = yield* db.select().from(WorkTaskTable).where(eq(WorkTaskTable.id, taskID)).get().pipe(Effect.orDie)
        return row ? WorkInfo.task(row) : undefined
      }),
      tasks: Effect.fn("WorkStore.tasks")(function* (goalID) {
        return (yield* db
          .select()
          .from(WorkTaskTable)
          .where(eq(WorkTaskTable.goal_id, goalID))
          .orderBy(asc(WorkTaskTable.time_created), asc(WorkTaskTable.id))
          .all()
          .pipe(Effect.orDie)).map(WorkInfo.task)
      }),
      getAttempt: Effect.fn("WorkStore.getAttempt")(function* (attemptID) {
        const row = yield* db
          .select()
          .from(WorkAttemptTable)
          .where(eq(WorkAttemptTable.id, attemptID))
          .get()
          .pipe(Effect.orDie)
        return row ? WorkInfo.attempt(row) : undefined
      }),
      attempts: Effect.fn("WorkStore.attempts")(function* (taskID) {
        return (yield* db
          .select()
          .from(WorkAttemptTable)
          .where(eq(WorkAttemptTable.task_id, taskID))
          .orderBy(asc(WorkAttemptTable.number))
          .all()
          .pipe(Effect.orDie)).map(WorkInfo.attempt)
      }),
      evidence: Effect.fn("WorkStore.evidence")(function* (taskID) {
        return (yield* db
          .select()
          .from(WorkEvidenceTable)
          .where(eq(WorkEvidenceTable.task_id, taskID))
          .orderBy(asc(WorkEvidenceTable.time_created), asc(WorkEvidenceTable.id))
          .all()
          .pipe(Effect.orDie)).map(WorkInfo.evidence)
      }),
      evaluations: Effect.fn("WorkStore.evaluations")(function* (taskID) {
        return (yield* db
          .select()
          .from(WorkEvaluationTable)
          .where(eq(WorkEvaluationTable.task_id, taskID))
          .orderBy(asc(WorkEvaluationTable.time_created), asc(WorkEvaluationTable.id))
          .all()
          .pipe(Effect.orDie)).map(WorkInfo.evaluation)
      }),
      handoff: Effect.fn("WorkStore.handoff")(function* (taskID) {
        const row = yield* db
          .select()
          .from(WorkHandoffTable)
          .where(eq(WorkHandoffTable.task_id, taskID))
          .get()
          .pipe(Effect.orDie)
        return row ? WorkInfo.handoff(row) : undefined
      }),
      handoffs: Effect.fn("WorkStore.handoffs")(function* (goalID) {
        return (yield* db
          .select()
          .from(WorkHandoffTable)
          .where(eq(WorkHandoffTable.goal_id, goalID))
          .orderBy(asc(WorkHandoffTable.time_created), asc(WorkHandoffTable.id))
          .all()
          .pipe(Effect.orDie)).map(WorkInfo.handoff)
      }),
      mailbox: Effect.fn("WorkStore.mailbox")(function* (taskID) {
        const task = yield* db
          .select({ goalID: WorkTaskTable.goal_id })
          .from(WorkTaskTable)
          .where(eq(WorkTaskTable.id, taskID))
          .get()
          .pipe(Effect.orDie)
        if (!task) return []
        return (yield* db
          .select()
          .from(WorkHandoffTable)
          .where(eq(WorkHandoffTable.goal_id, task.goalID))
          .orderBy(asc(WorkHandoffTable.time_created), asc(WorkHandoffTable.id))
          .all()
          .pipe(Effect.orDie))
          .filter((row) => row.recipients.includes(taskID))
          .map(WorkInfo.handoff)
      }),
      projectHandoffs: Effect.fn("WorkStore.projectHandoffs")(function* (location, limit = 64) {
        const rows = yield* db
          .select({ handoff: WorkHandoffTable })
          .from(WorkHandoffTable)
          .innerJoin(WorkGoalTable, eq(WorkGoalTable.id, WorkHandoffTable.goal_id))
          .where(
            and(
              eq(WorkGoalTable.directory, location.directory),
              location.workspaceID
                ? eq(WorkGoalTable.workspace_id, location.workspaceID)
                : isNull(WorkGoalTable.workspace_id),
            ),
          )
          .orderBy(desc(WorkHandoffTable.time_created), desc(WorkHandoffTable.id))
          .limit(limit)
          .all()
          .pipe(Effect.orDie)
        return rows.toReversed().map((row) => WorkInfo.handoff(row.handoff))
      }),
      projectMemoryResolutions: Effect.fn("WorkStore.projectMemoryResolutions")(function* (location, limit = 64) {
        return (yield* db
          .select()
          .from(WorkMemoryResolutionTable)
          .where(
            and(
              eq(WorkMemoryResolutionTable.directory, location.directory),
              location.workspaceID
                ? eq(WorkMemoryResolutionTable.workspace_id, location.workspaceID)
                : isNull(WorkMemoryResolutionTable.workspace_id),
            ),
          )
          .orderBy(desc(WorkMemoryResolutionTable.time_created), desc(WorkMemoryResolutionTable.id))
          .limit(limit)
          .all()
          .pipe(Effect.orDie))
          .toReversed()
          .map(WorkInfo.memoryResolution)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
