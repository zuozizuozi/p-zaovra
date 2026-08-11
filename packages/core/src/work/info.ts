export * as WorkInfo from "./info"

import { Work } from "@zaovra-ai/schema/work"
import { DateTime } from "effect"
import { AbsolutePath } from "../schema"
import { SessionSchema } from "../session/schema"
import { WorkspaceV2 } from "../workspace"
import {
  WorkAttemptTable,
  WorkEvaluationTable,
  WorkEvidenceTable,
  WorkGoalTable,
  WorkHandoffTable,
  WorkMemoryResolutionTable,
  WorkTaskTable,
} from "./sql"

export function goal(row: typeof WorkGoalTable.$inferSelect): Work.GoalInfo {
  return Work.GoalInfo.make({
    id: Work.GoalID.make(row.id),
    location: {
      directory: AbsolutePath.make(row.directory),
      workspaceID: row.workspace_id ? WorkspaceV2.ID.make(row.workspace_id) : undefined,
    },
    objective: row.objective,
    acceptanceCriteria: row.acceptance_criteria,
    roleContracts: row.role_contracts.length > 0 ? row.role_contracts : undefined,
    workerID: row.worker_id ? Work.WorkerID.make(row.worker_id) : undefined,
    status: row.status,
    budget: row.budget ?? undefined,
    usage: row.usage,
    revision: row.revision,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      completed: row.time_completed === null ? undefined : DateTime.makeUnsafe(row.time_completed),
    },
  })
}

export function task(row: typeof WorkTaskTable.$inferSelect): Work.TaskInfo {
  return Work.TaskInfo.make({
    id: Work.TaskID.make(row.id),
    goalID: Work.GoalID.make(row.goal_id),
    title: row.title,
    instructions: row.instructions,
    dependsOn: row.depends_on,
    role: row.role,
    location: row.directory
      ? {
          directory: AbsolutePath.make(row.directory),
          workspaceID: row.workspace_id ? WorkspaceV2.ID.make(row.workspace_id) : undefined,
        }
      : undefined,
    status: row.status,
    criteria: row.criteria,
    attemptCount: row.attempt_count,
    revision: row.revision,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      completed: row.time_completed === null ? undefined : DateTime.makeUnsafe(row.time_completed),
    },
  })
}

export function attempt(row: typeof WorkAttemptTable.$inferSelect): Work.AttemptInfo {
  return Work.AttemptInfo.make({
    id: Work.AttemptID.make(row.id),
    goalID: Work.GoalID.make(row.goal_id),
    taskID: Work.TaskID.make(row.task_id),
    kind: row.kind,
    number: row.number,
    sessionID: row.session_id ? SessionSchema.ID.make(row.session_id) : undefined,
    status: row.status,
    ownerID: row.owner_id ?? undefined,
    fence: row.fence ?? undefined,
    inputRevision: row.input_revision,
    failure: row.failure ?? undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      started: row.time_started === null ? undefined : DateTime.makeUnsafe(row.time_started),
      ended: row.time_ended === null ? undefined : DateTime.makeUnsafe(row.time_ended),
    },
  })
}

export function evidence(row: typeof WorkEvidenceTable.$inferSelect): Work.EvidenceInfo {
  return Work.EvidenceInfo.make({
    id: Work.EvidenceID.make(row.id),
    goalID: Work.GoalID.make(row.goal_id),
    taskID: Work.TaskID.make(row.task_id),
    attemptID: Work.AttemptID.make(row.attempt_id),
    criterionIDs: row.criterion_ids,
    kind: row.kind,
    producer: row.producer,
    payload: row.payload,
    digest: row.digest ?? undefined,
    reference: row.reference ?? undefined,
    createdAt: DateTime.makeUnsafe(row.time_created),
  })
}

export function evaluation(row: typeof WorkEvaluationTable.$inferSelect): Work.EvaluationInfo {
  return Work.EvaluationInfo.make({
    id: Work.EvaluationID.make(row.id),
    goalID: Work.GoalID.make(row.goal_id),
    taskID: Work.TaskID.make(row.task_id),
    attemptID: Work.AttemptID.make(row.attempt_id),
    criterionID: Work.CriterionID.make(row.criterion_id),
    evidenceIDs: row.evidence_ids,
    verdict: row.verdict,
    evaluator: row.evaluator,
    evaluatorVersion: row.evaluator_version,
    findings: row.findings,
    allowsRepair: row.allows_repair,
    createdAt: DateTime.makeUnsafe(row.time_created),
  })
}

export function handoff(row: typeof WorkHandoffTable.$inferSelect): Work.HandoffInfo {
  return Work.HandoffInfo.make({
    id: Work.HandoffID.make(row.id),
    goalID: Work.GoalID.make(row.goal_id),
    taskID: Work.TaskID.make(row.task_id),
    attemptID: Work.AttemptID.make(row.attempt_id),
    producer: row.producer,
    summary: row.summary,
    items: row.items,
    evidenceIDs: row.evidence_ids,
    recipients: row.recipients,
    digest: row.digest,
    createdAt: DateTime.makeUnsafe(row.time_created),
  })
}

export function memoryResolution(row: typeof WorkMemoryResolutionTable.$inferSelect): Work.MemoryResolutionInfo {
  return Work.MemoryResolutionInfo.make({
    id: Work.MemoryResolutionID.make(row.id),
    goalID: Work.GoalID.make(row.goal_id),
    location: {
      directory: AbsolutePath.make(row.directory),
      workspaceID: row.workspace_id ? WorkspaceV2.ID.make(row.workspace_id) : undefined,
    },
    key: row.key,
    handoffID: Work.HandoffID.make(row.handoff_id),
    handoffDigest: row.handoff_digest,
    itemDigest: row.item_digest,
    action: row.action,
    value: row.value ?? undefined,
    resolver: row.resolver,
    reason: row.reason ?? undefined,
    createdAt: DateTime.makeUnsafe(row.time_created),
  })
}
