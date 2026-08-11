import { Work } from "@zaovra-ai/schema/work"
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { directoryColumn } from "../database/path"
import { SessionTable } from "../session/sql"
import type { WorkspaceV2 } from "../workspace"

export const WorkGoalTable = sqliteTable(
  "work_goal",
  {
    id: text().$type<Work.GoalID>().primaryKey(),
    directory: directoryColumn().notNull(),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    objective: text().notNull(),
    acceptance_criteria: text({ mode: "json" }).$type<Work.Criterion[]>().notNull(),
    role_contracts: text({ mode: "json" }).$type<Work.RoleContract[]>().notNull().default([]),
    worker_id: text().$type<Work.WorkerID>(),
    status: text().$type<Work.GoalStatus>().notNull(),
    budget: text({ mode: "json" }).$type<Work.Budget>(),
    usage: text({ mode: "json" }).$type<Work.Usage>().notNull(),
    revision: integer().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [
    index("work_goal_location_status_updated_idx").on(
      table.directory,
      table.workspace_id,
      table.status,
      table.time_updated,
    ),
  ],
)

export const WorkTaskTable = sqliteTable(
  "work_task",
  {
    id: text().$type<Work.TaskID>().primaryKey(),
    goal_id: text()
      .$type<Work.GoalID>()
      .notNull()
      .references(() => WorkGoalTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    instructions: text().notNull(),
    depends_on: text({ mode: "json" }).$type<Work.TaskID[]>().notNull(),
    role: text().notNull(),
    directory: directoryColumn(),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    status: text().$type<Work.TaskStatus>().notNull(),
    criteria: text({ mode: "json" }).$type<Work.CriterionID[]>().notNull(),
    attempt_count: integer().notNull(),
    revision: integer().notNull(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [
    index("work_task_goal_status_created_idx").on(table.goal_id, table.status, table.time_created),
    index("work_task_status_updated_idx").on(table.status, table.time_updated),
  ],
)

export const WorkAttemptTable = sqliteTable(
  "work_attempt",
  {
    id: text().$type<Work.AttemptID>().primaryKey(),
    goal_id: text()
      .$type<Work.GoalID>()
      .notNull()
      .references(() => WorkGoalTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Work.TaskID>()
      .notNull()
      .references(() => WorkTaskTable.id, { onDelete: "cascade" }),
    kind: text().$type<Work.AttemptKind>().notNull(),
    number: integer().notNull(),
    session_id: text()
      .$type<Work.AttemptInfo["sessionID"]>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    status: text().$type<Work.AttemptStatus>().notNull(),
    owner_id: text(),
    fence: integer(),
    input_revision: integer().notNull(),
    failure: text({ mode: "json" }).$type<Work.Failure>(),
    time_created: integer().notNull(),
    time_started: integer(),
    time_ended: integer(),
  },
  (table) => [
    uniqueIndex("work_attempt_task_number_idx").on(table.task_id, table.number),
    index("work_attempt_goal_status_created_idx").on(table.goal_id, table.status, table.time_created),
    index("work_attempt_session_idx").on(table.session_id),
  ],
)

export const WorkLeaseTable = sqliteTable(
  "work_lease",
  {
    goal_id: text()
      .$type<Work.GoalID>()
      .primaryKey()
      .references(() => WorkGoalTable.id, { onDelete: "cascade" }),
    owner_id: text().notNull(),
    controller_id: text().$type<Work.ControllerID>(),
    controller_runtime_id: text().$type<Work.ControllerRuntimeID>(),
    worker_id: text().$type<Work.WorkerID>().notNull().default(Work.WorkerID.make("worker_local")),
    fence: integer().notNull(),
    expires_at: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("work_lease_expires_idx").on(table.expires_at)],
)

export const WorkControllerTable = sqliteTable(
  "work_controller",
  {
    id: text().$type<Work.ControllerID>().primaryKey(),
    runtime_id: text().$type<Work.ControllerRuntimeID>().notNull(),
    label: text().notNull(),
    endpoint: text(),
    draining: integer({ mode: "boolean" }).notNull().default(false),
    time_started: integer().notNull(),
    time_heartbeat: integer().notNull(),
    expires_at: integer().notNull(),
  },
  (table) => [index("work_controller_expires_idx").on(table.expires_at)],
)

export const WorkControllerDispatchTable = sqliteTable(
  "work_controller_dispatch",
  {
    goal_id: text()
      .$type<Work.GoalID>()
      .primaryKey()
      .references(() => WorkGoalTable.id, { onDelete: "cascade" }),
    signal: text().$type<Work.ControllerDispatchSignal>().notNull(),
    revision: integer().notNull(),
    processed_revision: integer().notNull().default(0),
    controller_id: text().$type<Work.ControllerID>(),
    runtime_id: text().$type<Work.ControllerRuntimeID>(),
    fence: integer().notNull().default(0),
    lease_expires_at: integer(),
    time_requested: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    index("work_controller_dispatch_pending_idx").on(table.processed_revision, table.revision, table.time_requested),
    index("work_controller_dispatch_lease_idx").on(table.lease_expires_at),
  ],
)

export const WorkWorkerTable = sqliteTable(
  "work_worker",
  {
    id: text().$type<Work.WorkerID>().primaryKey(),
    label: text().notNull(),
    endpoint: text(),
    capabilities: text({ mode: "json" }).$type<Work.WorkerCapability[]>().notNull(),
    workspace_roots: text({ mode: "json" }).$type<string[]>().notNull(),
    runtime_id: text().$type<Work.WorkerRuntimeID>(),
    capacity: integer().notNull().default(1),
    execution_mode: text().$type<Work.WorkerExecutionMode>().notNull().default("shared"),
    location_mappings: text({ mode: "json" }).$type<Work.WorkerLocationMapping[]>().notNull().default([]),
    draining: integer({ mode: "boolean" }).notNull().default(false),
    credential_hash: text(),
    credential_created_at: integer(),
    credential_last_used_at: integer(),
    credential_revoked_at: integer(),
    time_created: integer().notNull(),
    time_heartbeat: integer().notNull(),
    expires_at: integer().notNull(),
  },
  (table) => [index("work_worker_expires_idx").on(table.expires_at)],
)

export const WorkWorkerJobTable = sqliteTable(
  "work_worker_job",
  {
    id: text().$type<Work.WorkerJobID>().primaryKey(),
    worker_id: text()
      .$type<Work.WorkerID>()
      .notNull()
      .references(() => WorkWorkerTable.id, { onDelete: "cascade" }),
    goal_id: text()
      .$type<Work.GoalID>()
      .notNull()
      .references(() => WorkGoalTable.id, { onDelete: "cascade" }),
    attempt_id: text()
      .$type<Work.AttemptID>()
      .notNull()
      .references(() => WorkAttemptTable.id, { onDelete: "cascade" }),
    criterion_id: text().$type<Work.CriterionID>().notNull(),
    status: text().$type<Work.WorkerJobStatus>().notNull(),
    lease_runtime_id: text().$type<Work.WorkerRuntimeID>(),
    fence: integer().notNull(),
    operation: text({ mode: "json" }).$type<Work.WorkerJobOperation>().notNull(),
    result: text({ mode: "json" }).$type<Work.WorkerJobResult>(),
    lease_expires_at: integer(),
    cancel_reason: text(),
    cancel_requested_at: integer(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [
    uniqueIndex("work_worker_job_attempt_criterion_idx").on(table.attempt_id, table.criterion_id),
    index("work_worker_job_worker_status_created_idx").on(table.worker_id, table.status, table.time_created),
    index("work_worker_job_lease_expires_idx").on(table.lease_expires_at),
  ],
)

export const WorkWorkerJobOutboxTable = sqliteTable(
  "work_worker_job_outbox",
  {
    job_id: text().$type<Work.WorkerJobID>().primaryKey(),
    worker_id: text().$type<Work.WorkerID>().notNull(),
    runtime_id: text().$type<Work.WorkerRuntimeID>().notNull(),
    fence: integer().notNull(),
    operation: text({ mode: "json" }).$type<Work.WorkerJobOperation>().notNull(),
    state: text().$type<Work.WorkerJobOutboxState>().notNull(),
    result: text({ mode: "json" }).$type<Work.WorkerJobResult>(),
    artifacts: text({ mode: "json" }).$type<Work.WorkerPendingArtifact[]>().notNull().default([]),
    time_updated: integer().notNull(),
  },
  (table) => [index("work_worker_job_outbox_state_updated_idx").on(table.state, table.time_updated)],
)

export const WorkWorkerJobLogTable = sqliteTable(
  "work_worker_job_log",
  {
    job_id: text()
      .$type<Work.WorkerJobID>()
      .notNull()
      .references(() => WorkWorkerJobTable.id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    worker_id: text()
      .$type<Work.WorkerID>()
      .notNull()
      .references(() => WorkWorkerTable.id, { onDelete: "cascade" }),
    fence: integer().notNull(),
    stream: text().$type<Work.WorkerJobLogStream>().notNull(),
    message: text().notNull(),
    size: integer().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.job_id, table.sequence] }),
    index("work_worker_job_log_created_idx").on(table.job_id, table.time_created),
  ],
)

export const WorkWorkerJobArtifactTable = sqliteTable(
  "work_worker_job_artifact",
  {
    job_id: text()
      .$type<Work.WorkerJobID>()
      .notNull()
      .references(() => WorkWorkerJobTable.id, { onDelete: "cascade" }),
    digest: text().$type<Work.ArtifactDigest>().notNull(),
    worker_id: text()
      .$type<Work.WorkerID>()
      .notNull()
      .references(() => WorkWorkerTable.id, { onDelete: "cascade" }),
    fence: integer().notNull(),
    label: text().notNull(),
    reference: text().notNull(),
    size: integer().notNull(),
    media_type: text().$type<Work.ArtifactReference["mediaType"]>().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.job_id, table.digest] }),
    index("work_worker_job_artifact_created_idx").on(table.job_id, table.time_created),
  ],
)

export const WorkArtifactTable = sqliteTable(
  "work_artifact",
  {
    digest: text().$type<Work.ArtifactDigest>().primaryKey(),
    reference: text().notNull(),
    size: integer().notNull(),
    media_type: text().$type<Work.ArtifactReference["mediaType"]>().notNull(),
    time_created: integer().notNull(),
    time_accessed: integer().notNull(),
    time_collected: integer(),
  },
  (table) => [index("work_artifact_accessed_idx").on(table.time_collected, table.time_accessed)],
)

export const WorkArtifactOwnerTable = sqliteTable(
  "work_artifact_owner",
  {
    digest: text()
      .$type<Work.ArtifactDigest>()
      .notNull()
      .references(() => WorkArtifactTable.digest, { onDelete: "cascade" }),
    owner_type: text().notNull(),
    owner_id: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.digest, table.owner_type, table.owner_id] }),
    index("work_artifact_owner_owner_idx").on(table.owner_type, table.owner_id),
  ],
)

export const WorkEvidenceTable = sqliteTable(
  "work_evidence",
  {
    id: text().$type<Work.EvidenceID>().primaryKey(),
    goal_id: text()
      .$type<Work.GoalID>()
      .notNull()
      .references(() => WorkGoalTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Work.TaskID>()
      .notNull()
      .references(() => WorkTaskTable.id, { onDelete: "cascade" }),
    attempt_id: text()
      .$type<Work.AttemptID>()
      .notNull()
      .references(() => WorkAttemptTable.id, { onDelete: "cascade" }),
    criterion_ids: text({ mode: "json" }).$type<Work.CriterionID[]>().notNull(),
    kind: text().$type<Work.EvidenceKind>().notNull(),
    producer: text().notNull(),
    payload: text({ mode: "json" }).$type<Work.EvidenceInfo["payload"]>().notNull(),
    digest: text(),
    reference: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("work_evidence_attempt_created_idx").on(table.attempt_id, table.time_created),
    index("work_evidence_task_created_idx").on(table.task_id, table.time_created),
  ],
)

export const WorkEvaluationTable = sqliteTable(
  "work_evaluation",
  {
    id: text().$type<Work.EvaluationID>().primaryKey(),
    goal_id: text()
      .$type<Work.GoalID>()
      .notNull()
      .references(() => WorkGoalTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Work.TaskID>()
      .notNull()
      .references(() => WorkTaskTable.id, { onDelete: "cascade" }),
    attempt_id: text()
      .$type<Work.AttemptID>()
      .notNull()
      .references(() => WorkAttemptTable.id, { onDelete: "cascade" }),
    criterion_id: text().$type<Work.CriterionID>().notNull(),
    evidence_ids: text({ mode: "json" }).$type<Work.EvidenceID[]>().notNull(),
    verdict: text().$type<Work.Verdict>().notNull(),
    evaluator: text().notNull(),
    evaluator_version: text().notNull(),
    findings: text({ mode: "json" }).$type<Work.Finding[]>().notNull(),
    allows_repair: integer({ mode: "boolean" }).notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("work_evaluation_task_criterion_created_idx").on(table.task_id, table.criterion_id, table.time_created),
    index("work_evaluation_attempt_created_idx").on(table.attempt_id, table.time_created),
  ],
)

export const WorkHandoffTable = sqliteTable(
  "work_handoff",
  {
    id: text().$type<Work.HandoffID>().primaryKey(),
    goal_id: text()
      .$type<Work.GoalID>()
      .notNull()
      .references(() => WorkGoalTable.id, { onDelete: "cascade" }),
    task_id: text()
      .$type<Work.TaskID>()
      .notNull()
      .references(() => WorkTaskTable.id, { onDelete: "cascade" }),
    attempt_id: text()
      .$type<Work.AttemptID>()
      .notNull()
      .references(() => WorkAttemptTable.id, { onDelete: "cascade" }),
    producer: text().notNull(),
    summary: text().notNull(),
    items: text({ mode: "json" }).$type<Work.HandoffItem[]>().notNull(),
    evidence_ids: text({ mode: "json" }).$type<Work.EvidenceID[]>().notNull(),
    recipients: text({ mode: "json" }).$type<Work.TaskID[]>().notNull().default([]),
    digest: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("work_handoff_task_idx").on(table.task_id),
    uniqueIndex("work_handoff_attempt_idx").on(table.attempt_id),
    index("work_handoff_goal_created_idx").on(table.goal_id, table.time_created),
  ],
)

export const WorkMemoryResolutionTable = sqliteTable(
  "work_memory_resolution",
  {
    id: text().$type<Work.MemoryResolutionID>().primaryKey(),
    goal_id: text()
      .$type<Work.GoalID>()
      .notNull()
      .references(() => WorkGoalTable.id, { onDelete: "cascade" }),
    directory: directoryColumn().notNull(),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    key: text().notNull(),
    handoff_id: text()
      .$type<Work.HandoffID>()
      .notNull()
      .references(() => WorkHandoffTable.id, { onDelete: "cascade" }),
    handoff_digest: text().notNull(),
    item_digest: text().notNull(),
    action: text().$type<"select" | "replace" | "delete">().notNull().default("select"),
    value: text({ mode: "json" }).$type<Work.HandoffItem>(),
    resolver: text().notNull(),
    reason: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("work_memory_resolution_location_key_created_idx").on(
      table.directory,
      table.workspace_id,
      table.key,
      table.time_created,
    ),
    index("work_memory_resolution_goal_created_idx").on(table.goal_id, table.time_created),
  ],
)
