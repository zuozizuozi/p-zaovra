import { Schema } from "effect"
import { Agent } from "./agent"
import { Location } from "./location"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, optional } from "./schema"
import { SessionID } from "./session-id"
import {
  AttemptID,
  ControllerID,
  ControllerRuntimeID,
  CriterionID,
  EvaluationID,
  EvidenceID,
  GoalID,
  HandoffID,
  MemoryResolutionID,
  TaskID,
  WorkerID,
  WorkerJobID,
  WorkerRuntimeID,
} from "./work-id"

export const GoalStatus = Schema.Literals([
  "draft",
  "active",
  "pausing",
  "paused",
  "cancelling",
  "completed",
  "blocked",
  "cancelled",
  "budget_exhausted",
]).annotate({ identifier: "Work.GoalStatus" })
export type GoalStatus = typeof GoalStatus.Type

export const TaskStatus = Schema.Literals([
  "pending",
  "ready",
  "running",
  "verifying",
  "reviewing",
  "merging",
  "rework",
  "completed",
  "superseded",
  "blocked",
  "cancelled",
]).annotate({ identifier: "Work.TaskStatus" })
export type TaskStatus = typeof TaskStatus.Type

export const AttemptStatus = Schema.Literals([
  "admitted",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "unknown",
  "cancelled",
]).annotate({ identifier: "Work.AttemptStatus" })
export type AttemptStatus = typeof AttemptStatus.Type

export const AttemptKind = Schema.Literals(["plan", "replan", "execute", "repair", "verify", "review"]).annotate({
  identifier: "Work.AttemptKind",
})
export type AttemptKind = typeof AttemptKind.Type

export const EvidenceKind = Schema.Literals([
  "command",
  "test",
  "diff",
  "artifact",
  "review",
  "manual",
  "external",
]).annotate({ identifier: "Work.EvidenceKind" })
export type EvidenceKind = typeof EvidenceKind.Type

export const ArtifactDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).annotate({
  identifier: "Work.ArtifactDigest",
})
export type ArtifactDigest = typeof ArtifactDigest.Type

export const ArtifactReference = Schema.Struct({
  digest: ArtifactDigest,
  reference: Schema.String.check(Schema.isPattern(/^zaovra-work-artifact:\/\/sha256\/[a-f0-9]{64}$/)),
  size: NonNegativeInt,
  mediaType: Schema.Literal("text/x-diff"),
}).annotate({ identifier: "Work.ArtifactReference" })
export interface ArtifactReference extends Schema.Schema.Type<typeof ArtifactReference> {}

export const ArtifactLifecycleInfo = Schema.Struct({
  artifact: ArtifactReference,
  referenceCount: NonNegativeInt,
  state: Schema.Literals(["active", "collected"]),
  createdAt: DateTimeUtcFromMillis,
  accessedAt: DateTimeUtcFromMillis,
  collectedAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Work.ArtifactLifecycleInfo" })
export interface ArtifactLifecycleInfo extends Schema.Schema.Type<typeof ArtifactLifecycleInfo> {}

export const ArtifactCollectionReport = Schema.Struct({
  dryRun: Schema.Boolean,
  scanned: NonNegativeInt,
  collected: NonNegativeInt,
  reclaimedBytes: NonNegativeInt,
  artifacts: Schema.Array(ArtifactReference),
}).annotate({ identifier: "Work.ArtifactCollectionReport" })
export interface ArtifactCollectionReport extends Schema.Schema.Type<typeof ArtifactCollectionReport> {}

export const Verdict = Schema.Literals(["pass", "fail", "blocked"]).annotate({ identifier: "Work.Verdict" })
export type Verdict = typeof Verdict.Type

export const FailureKind = Schema.Literals([
  "error",
  "interrupted",
  "unknown",
  "cancelled",
  "permission",
  "budget",
]).annotate({ identifier: "Work.FailureKind" })
export type FailureKind = typeof FailureKind.Type

export const CommandVerifier = Schema.Struct({
  type: Schema.Literal("command"),
  command: Schema.String,
  timeoutMs: PositiveInt.pipe(optional),
  successExitCodes: Schema.Array(NonNegativeInt).pipe(optional),
}).annotate({ identifier: "Work.CommandVerifier" })
export interface CommandVerifier extends Schema.Schema.Type<typeof CommandVerifier> {}

export const FileVerifier = Schema.Struct({
  type: Schema.Literal("file"),
  path: Schema.String,
  expected: Schema.Literals(["exists", "file", "directory"]),
}).annotate({ identifier: "Work.FileVerifier" })
export interface FileVerifier extends Schema.Schema.Type<typeof FileVerifier> {}

export const Verifier = Schema.Union([CommandVerifier, FileVerifier])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Work.Verifier" })
export type Verifier = typeof Verifier.Type

export const Criterion = Schema.Struct({
  id: CriterionID,
  description: Schema.String,
  required: Schema.Boolean,
  evidence: EvidenceKind,
  verifier: Verifier.pipe(optional),
}).annotate({ identifier: "Work.Criterion" })
export interface Criterion extends Schema.Schema.Type<typeof Criterion> {}

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const Budget = Schema.Struct({
  maxAttemptsPerTask: PositiveInt.pipe(optional),
  maxRepairAttempts: PositiveInt.pipe(optional),
  maxParallelTasks: PositiveInt.pipe(optional),
  maxReplans: PositiveInt.pipe(optional),
  maxTurns: PositiveInt.pipe(optional),
  maxDurationMs: PositiveInt.pipe(optional),
  maxCost: NonNegativeFinite.pipe(optional),
}).annotate({ identifier: "Work.Budget" })
export interface Budget extends Schema.Schema.Type<typeof Budget> {}

export const Usage = Schema.Struct({
  attempts: NonNegativeInt,
  repairs: NonNegativeInt,
  turns: NonNegativeInt,
  cost: NonNegativeFinite,
}).annotate({ identifier: "Work.Usage" })
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

export const GoalTime = Schema.Struct({
  created: DateTimeUtcFromMillis,
  updated: DateTimeUtcFromMillis,
  completed: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Work.GoalTime" })
export interface GoalTime extends Schema.Schema.Type<typeof GoalTime> {}

export const GoalInfo = Schema.Struct({
  id: GoalID,
  location: Location.Ref,
  objective: Schema.String,
  acceptanceCriteria: Schema.Array(Criterion),
  roleContracts: Schema.suspend(() => Schema.Array(RoleContract)).pipe(optional),
  workerID: WorkerID.pipe(optional),
  status: GoalStatus,
  budget: Budget.pipe(optional),
  usage: Usage,
  time: GoalTime,
  revision: NonNegativeInt,
}).annotate({ identifier: "Work.GoalInfo" })
export interface GoalInfo extends Schema.Schema.Type<typeof GoalInfo> {}

export const TaskTime = Schema.Struct({
  created: DateTimeUtcFromMillis,
  updated: DateTimeUtcFromMillis,
  completed: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Work.TaskTime" })
export interface TaskTime extends Schema.Schema.Type<typeof TaskTime> {}

export const TaskInfo = Schema.Struct({
  id: TaskID,
  goalID: GoalID,
  title: Schema.String,
  instructions: Schema.String,
  dependsOn: Schema.Array(TaskID),
  role: Schema.String,
  location: Location.Ref.pipe(optional),
  status: TaskStatus,
  criteria: Schema.Array(CriterionID),
  attemptCount: NonNegativeInt,
  time: TaskTime,
  revision: NonNegativeInt,
}).annotate({ identifier: "Work.TaskInfo" })
export interface TaskInfo extends Schema.Schema.Type<typeof TaskInfo> {}

export const Failure = Schema.Struct({
  kind: FailureKind,
  message: Schema.String,
  retryable: Schema.Boolean,
  details: Schema.Json.pipe(optional),
}).annotate({ identifier: "Work.Failure" })
export interface Failure extends Schema.Schema.Type<typeof Failure> {}

export const AttemptTime = Schema.Struct({
  created: DateTimeUtcFromMillis,
  started: DateTimeUtcFromMillis.pipe(optional),
  ended: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Work.AttemptTime" })
export interface AttemptTime extends Schema.Schema.Type<typeof AttemptTime> {}

export const AttemptInfo = Schema.Struct({
  id: AttemptID,
  goalID: GoalID,
  taskID: TaskID,
  kind: AttemptKind,
  number: PositiveInt,
  sessionID: SessionID.pipe(optional),
  status: AttemptStatus,
  ownerID: Schema.String.pipe(optional),
  fence: NonNegativeInt.pipe(optional),
  inputRevision: NonNegativeInt,
  failure: Failure.pipe(optional),
  time: AttemptTime,
}).annotate({ identifier: "Work.AttemptInfo" })
export interface AttemptInfo extends Schema.Schema.Type<typeof AttemptInfo> {}

export const EvidenceInfo = Schema.Struct({
  id: EvidenceID,
  goalID: GoalID,
  taskID: TaskID,
  attemptID: AttemptID,
  criterionIDs: Schema.Array(CriterionID),
  kind: EvidenceKind,
  producer: Schema.String,
  payload: Schema.Json,
  digest: Schema.String.pipe(optional),
  reference: Schema.String.pipe(optional),
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.EvidenceInfo" })
export interface EvidenceInfo extends Schema.Schema.Type<typeof EvidenceInfo> {}

export const Finding = Schema.Struct({
  code: Schema.String.pipe(optional),
  message: Schema.String,
  severity: Schema.Literals(["info", "warning", "error"]),
  location: Schema.String.pipe(optional),
}).annotate({ identifier: "Work.Finding" })
export interface Finding extends Schema.Schema.Type<typeof Finding> {}

export const EvaluationInfo = Schema.Struct({
  id: EvaluationID,
  goalID: GoalID,
  taskID: TaskID,
  attemptID: AttemptID,
  criterionID: CriterionID,
  evidenceIDs: Schema.Array(EvidenceID),
  verdict: Verdict,
  evaluator: Schema.String,
  evaluatorVersion: Schema.String,
  findings: Schema.Array(Finding),
  allowsRepair: Schema.Boolean,
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.EvaluationInfo" })
export interface EvaluationInfo extends Schema.Schema.Type<typeof EvaluationInfo> {}

export const HandoffItemKind = Schema.Literals([
  "result",
  "fact",
  "decision",
  "constraint",
  "risk",
  "artifact",
  "lesson",
  "next_action",
]).annotate({ identifier: "Work.HandoffItemKind" })
export type HandoffItemKind = typeof HandoffItemKind.Type

export const MemoryScope = Schema.Literals(["task", "project"]).annotate({ identifier: "Work.MemoryScope" })
export type MemoryScope = typeof MemoryScope.Type

export const HandoffItem = Schema.Struct({
  kind: HandoffItemKind,
  text: Schema.String,
  reference: Schema.String.pipe(optional),
  memory: MemoryScope.pipe(optional),
  key: Schema.String.pipe(optional),
  expiresAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Work.HandoffItem" })
export interface HandoffItem extends Schema.Schema.Type<typeof HandoffItem> {}

export const HandoffOutput = Schema.Struct({
  summary: Schema.String,
  items: Schema.Array(HandoffItem),
}).annotate({ identifier: "Work.HandoffOutput" })
export interface HandoffOutput extends Schema.Schema.Type<typeof HandoffOutput> {}

export const HandoffInfo = Schema.Struct({
  id: HandoffID,
  goalID: GoalID,
  taskID: TaskID,
  attemptID: AttemptID,
  producer: Schema.String,
  summary: Schema.String,
  items: Schema.Array(HandoffItem),
  evidenceIDs: Schema.Array(EvidenceID),
  recipients: Schema.Array(TaskID),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.HandoffInfo" })
export interface HandoffInfo extends Schema.Schema.Type<typeof HandoffInfo> {}

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

export const MemoryResolutionInfo = Schema.Struct({
  id: MemoryResolutionID,
  goalID: GoalID,
  location: Location.Ref,
  key: Schema.String,
  handoffID: HandoffID,
  handoffDigest: Sha256,
  itemDigest: Sha256,
  action: Schema.Literals(["select", "replace", "delete"]),
  value: HandoffItem.pipe(optional),
  resolver: Schema.String,
  reason: Schema.String.pipe(optional),
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.MemoryResolutionInfo" })
export interface MemoryResolutionInfo extends Schema.Schema.Type<typeof MemoryResolutionInfo> {}

export const ProjectMemoryCandidate = Schema.Struct({
  handoffID: HandoffID,
  goalID: GoalID,
  taskID: TaskID,
  producer: Schema.String,
  item: HandoffItem,
  itemDigest: Sha256,
  evidenceIDs: Schema.Array(EvidenceID),
  digest: Sha256,
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.ProjectMemoryCandidate" })
export interface ProjectMemoryCandidate extends Schema.Schema.Type<typeof ProjectMemoryCandidate> {}

export const ProjectMemoryEntry = Schema.Struct({
  key: Schema.String,
  status: Schema.Literals(["current", "conflicted", "resolved"]),
  candidates: Schema.Array(ProjectMemoryCandidate),
  resolution: MemoryResolutionInfo.pipe(optional),
}).annotate({ identifier: "Work.ProjectMemoryEntry" })
export interface ProjectMemoryEntry extends Schema.Schema.Type<typeof ProjectMemoryEntry> {}

export const ProjectMemoryView = Schema.Struct({
  entries: Schema.Array(ProjectMemoryEntry),
  resolutions: Schema.Array(MemoryResolutionInfo),
}).annotate({ identifier: "Work.ProjectMemoryView" })
export interface ProjectMemoryView extends Schema.Schema.Type<typeof ProjectMemoryView> {}

export const ControllerStatus = Schema.Literals(["online", "draining", "offline"]).annotate({
  identifier: "Work.ControllerStatus",
})
export type ControllerStatus = typeof ControllerStatus.Type

export const ControllerInfo = Schema.Struct({
  id: ControllerID,
  runtimeID: ControllerRuntimeID,
  label: Schema.String,
  endpoint: Schema.String.pipe(optional),
  status: ControllerStatus,
  startedAt: DateTimeUtcFromMillis,
  heartbeatAt: DateTimeUtcFromMillis,
  expiresAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.ControllerInfo" })
export interface ControllerInfo extends Schema.Schema.Type<typeof ControllerInfo> {}

export const ControllerDispatchSignal = Schema.Literals(["wake", "interrupt"]).annotate({
  identifier: "Work.ControllerDispatchSignal",
})
export type ControllerDispatchSignal = typeof ControllerDispatchSignal.Type

export const ControllerDispatchInfo = Schema.Struct({
  goalID: GoalID,
  signal: ControllerDispatchSignal,
  revision: PositiveInt,
  processedRevision: NonNegativeInt,
  controllerID: ControllerID.pipe(optional),
  runtimeID: ControllerRuntimeID.pipe(optional),
  fence: NonNegativeInt,
  status: Schema.Literals(["pending", "leased", "settled"]),
  leaseExpiresAt: DateTimeUtcFromMillis.pipe(optional),
  requestedAt: DateTimeUtcFromMillis,
  updatedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.ControllerDispatchInfo" })
export interface ControllerDispatchInfo extends Schema.Schema.Type<typeof ControllerDispatchInfo> {}

export const WorkerCapability = Schema.Literals(["execute", "worktree", "mcp"]).annotate({
  identifier: "Work.WorkerCapability",
})
export type WorkerCapability = typeof WorkerCapability.Type

export const WorkerStatus = Schema.Literals(["online", "draining", "offline"]).annotate({
  identifier: "Work.WorkerStatus",
})
export type WorkerStatus = typeof WorkerStatus.Type

export const WorkerCredentialStatus = Schema.Literals(["local", "enrolled", "revoked"]).annotate({
  identifier: "Work.WorkerCredentialStatus",
})
export type WorkerCredentialStatus = typeof WorkerCredentialStatus.Type

export const WorkerExecutionMode = Schema.Literals(["shared", "remote"]).annotate({
  identifier: "Work.WorkerExecutionMode",
})
export type WorkerExecutionMode = typeof WorkerExecutionMode.Type

export const WorkerLocationMapping = Schema.Struct({
  controllerRoot: Schema.String,
  workerRoot: Schema.String,
}).annotate({ identifier: "Work.WorkerLocationMapping" })
export interface WorkerLocationMapping extends Schema.Schema.Type<typeof WorkerLocationMapping> {}

export const WorkerInfo = Schema.Struct({
  id: WorkerID,
  runtimeID: WorkerRuntimeID.pipe(optional),
  label: Schema.String,
  endpoint: Schema.String.pipe(optional),
  capabilities: Schema.Array(WorkerCapability),
  workspaceRoots: Schema.Array(Schema.String),
  status: WorkerStatus,
  credentialStatus: WorkerCredentialStatus,
  executionMode: WorkerExecutionMode,
  capacity: PositiveInt,
  locationMappings: Schema.Array(WorkerLocationMapping),
  credentialCreatedAt: DateTimeUtcFromMillis.pipe(optional),
  credentialLastUsedAt: DateTimeUtcFromMillis.pipe(optional),
  credentialRevokedAt: DateTimeUtcFromMillis.pipe(optional),
  createdAt: DateTimeUtcFromMillis,
  heartbeatAt: DateTimeUtcFromMillis,
  expiresAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.WorkerInfo" })
export interface WorkerInfo extends Schema.Schema.Type<typeof WorkerInfo> {}

export const WorkerEnrollment = Schema.Struct({
  worker: WorkerInfo,
  token: Schema.String,
}).annotate({ identifier: "Work.WorkerEnrollment" })
export interface WorkerEnrollment extends Schema.Schema.Type<typeof WorkerEnrollment> {}

export const WorkerAssignmentInfo = Schema.Struct({
  goalID: GoalID,
  location: Location.Ref,
  status: GoalStatus,
  action: Schema.Literals(["wake", "recover"]),
  revision: NonNegativeInt,
  updatedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.WorkerAssignmentInfo" })
export interface WorkerAssignmentInfo extends Schema.Schema.Type<typeof WorkerAssignmentInfo> {}

export const WorkerJobStatus = Schema.Literals([
  "queued",
  "leased",
  "cancelling",
  "completed",
  "unknown",
  "cancelled",
]).annotate({ identifier: "Work.WorkerJobStatus" })
export type WorkerJobStatus = typeof WorkerJobStatus.Type

export const WorkerGitDiffCapture = Schema.Struct({
  type: Schema.Literal("git_diff"),
  baseRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  maxBytes: PositiveInt,
  startDigest: ArtifactDigest.pipe(optional),
}).annotate({ identifier: "Work.WorkerGitDiffCapture" })
export interface WorkerGitDiffCapture extends Schema.Schema.Type<typeof WorkerGitDiffCapture> {}

export const WorkerCommandOperation = Schema.Struct({
  type: Schema.Literal("command"),
  command: Schema.String,
  location: Location.Ref,
  timeoutMs: PositiveInt,
  maxOutputBytes: PositiveInt,
  artifactCapture: WorkerGitDiffCapture.pipe(optional),
}).annotate({ identifier: "Work.WorkerCommandOperation" })
export interface WorkerCommandOperation extends Schema.Schema.Type<typeof WorkerCommandOperation> {}

export const WorkerFileOperation = Schema.Struct({
  type: Schema.Literal("file"),
  path: Schema.String,
  expected: Schema.Literals(["exists", "file", "directory"]),
  location: Location.Ref,
}).annotate({ identifier: "Work.WorkerFileOperation" })
export interface WorkerFileOperation extends Schema.Schema.Type<typeof WorkerFileOperation> {}

export const WorkerAgentOperation = Schema.Struct({
  type: Schema.Literal("agent"),
  sessionID: SessionID,
  agent: Agent.ID,
  prompt: Schema.String,
  location: Location.Ref,
  artifactCapture: WorkerGitDiffCapture,
}).annotate({ identifier: "Work.WorkerAgentOperation" })
export interface WorkerAgentOperation extends Schema.Schema.Type<typeof WorkerAgentOperation> {}

export const WorkerJobOperation = Schema.Union([WorkerCommandOperation, WorkerFileOperation, WorkerAgentOperation])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Work.WorkerJobOperation" })
export type WorkerJobOperation = typeof WorkerJobOperation.Type

export const WorkerCommandResult = Schema.Struct({
  type: Schema.Literal("command"),
  interrupted: Schema.Boolean.pipe(optional),
  exitCode: Schema.Int.pipe(optional),
  output: Schema.String.pipe(optional),
  outputTruncated: Schema.Boolean,
  error: Schema.String.pipe(optional),
  baseRevision: Schema.String.pipe(optional),
  artifacts: Schema.Array(ArtifactReference).pipe(optional),
  artifactError: Schema.String.pipe(optional),
}).annotate({ identifier: "Work.WorkerCommandResult" })
export interface WorkerCommandResult extends Schema.Schema.Type<typeof WorkerCommandResult> {}

export const WorkerFileResult = Schema.Struct({
  type: Schema.Literal("file"),
  target: Schema.String.pipe(optional),
  actual: Schema.Literals(["missing", "file", "directory", "other", "outside_workspace"]).pipe(optional),
  error: Schema.String.pipe(optional),
}).annotate({ identifier: "Work.WorkerFileResult" })
export interface WorkerFileResult extends Schema.Schema.Type<typeof WorkerFileResult> {}

export const WorkerAgentResult = Schema.Struct({
  type: Schema.Literal("agent"),
  sessionID: SessionID,
  status: Schema.Literals(["succeeded", "failed", "interrupted", "unknown"]),
  finalResponse: Schema.String.pipe(optional),
  responseDigest: ArtifactDigest.pipe(optional),
  outputTruncated: Schema.Boolean,
  stepCount: NonNegativeInt,
  toolCallCount: NonNegativeInt,
  error: Schema.String.pipe(optional),
  baseRevision: Schema.String.pipe(optional),
  workspaceDigest: ArtifactDigest.pipe(optional),
  artifacts: Schema.Array(ArtifactReference).pipe(optional),
  artifactError: Schema.String.pipe(optional),
}).annotate({ identifier: "Work.WorkerAgentResult" })
export interface WorkerAgentResult extends Schema.Schema.Type<typeof WorkerAgentResult> {}

export const WorkerJobResult = Schema.Union([WorkerCommandResult, WorkerFileResult, WorkerAgentResult])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Work.WorkerJobResult" })
export type WorkerJobResult = typeof WorkerJobResult.Type

export const WorkerJobLogStream = Schema.Literals(["system", "output", "error"]).annotate({
  identifier: "Work.WorkerJobLogStream",
})
export type WorkerJobLogStream = typeof WorkerJobLogStream.Type

export const WorkerJobLogEntry = Schema.Struct({
  jobID: WorkerJobID,
  sequence: PositiveInt,
  stream: WorkerJobLogStream,
  message: Schema.String,
  size: NonNegativeInt,
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.WorkerJobLogEntry" })
export interface WorkerJobLogEntry extends Schema.Schema.Type<typeof WorkerJobLogEntry> {}

export const WorkerJobArtifactInfo = Schema.Struct({
  jobID: WorkerJobID,
  workerID: WorkerID,
  fence: PositiveInt,
  label: Schema.String,
  artifact: ArtifactReference,
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.WorkerJobArtifactInfo" })
export interface WorkerJobArtifactInfo extends Schema.Schema.Type<typeof WorkerJobArtifactInfo> {}

export const WorkerJobAssignment = Schema.Struct({
  id: WorkerJobID,
  goalID: GoalID,
  attemptID: AttemptID,
  criterionID: CriterionID,
  runtimeID: WorkerRuntimeID,
  fence: PositiveInt,
  operation: WorkerJobOperation,
  recovered: Schema.Boolean,
  nextLogSequence: PositiveInt,
  leaseExpiresAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.WorkerJobAssignment" })
export interface WorkerJobAssignment extends Schema.Schema.Type<typeof WorkerJobAssignment> {}

export const WorkerJobInfo = Schema.Struct({
  id: WorkerJobID,
  workerID: WorkerID,
  goalID: GoalID,
  attemptID: AttemptID,
  criterionID: CriterionID,
  status: WorkerJobStatus,
  runtimeID: WorkerRuntimeID.pipe(optional),
  fence: NonNegativeInt,
  operation: WorkerJobOperation,
  result: WorkerJobResult.pipe(optional),
  artifacts: Schema.Array(WorkerJobArtifactInfo),
  logCount: NonNegativeInt,
  lastLog: WorkerJobLogEntry.pipe(optional),
  leaseExpiresAt: DateTimeUtcFromMillis.pipe(optional),
  cancelReason: Schema.String.pipe(optional),
  cancelRequestedAt: DateTimeUtcFromMillis.pipe(optional),
  createdAt: DateTimeUtcFromMillis,
  updatedAt: DateTimeUtcFromMillis,
  completedAt: DateTimeUtcFromMillis.pipe(optional),
}).annotate({ identifier: "Work.WorkerJobInfo" })
export interface WorkerJobInfo extends Schema.Schema.Type<typeof WorkerJobInfo> {}

export const WorkerJobDetail = Schema.Struct({
  job: WorkerJobInfo,
  logs: Schema.Array(WorkerJobLogEntry),
}).annotate({ identifier: "Work.WorkerJobDetail" })
export interface WorkerJobDetail extends Schema.Schema.Type<typeof WorkerJobDetail> {}

export const WorkerJobArtifactContent = Schema.Struct({
  artifact: WorkerJobArtifactInfo,
  content: Schema.String,
}).annotate({ identifier: "Work.WorkerJobArtifactContent" })
export interface WorkerJobArtifactContent extends Schema.Schema.Type<typeof WorkerJobArtifactContent> {}

export const WorkerJobCancellation = Schema.Struct({
  id: WorkerJobID,
  runtimeID: WorkerRuntimeID,
  fence: PositiveInt,
  reason: Schema.String,
  requestedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.WorkerJobCancellation" })
export interface WorkerJobCancellation extends Schema.Schema.Type<typeof WorkerJobCancellation> {}

export const WorkerPendingArtifact = Schema.Struct({
  label: Schema.String,
  content: Schema.String,
}).annotate({ identifier: "Work.WorkerPendingArtifact" })
export interface WorkerPendingArtifact extends Schema.Schema.Type<typeof WorkerPendingArtifact> {}

export const WorkerJobOutboxState = Schema.Literals(["executing", "result_ready"]).annotate({
  identifier: "Work.WorkerJobOutboxState",
})
export type WorkerJobOutboxState = typeof WorkerJobOutboxState.Type

export const WorkerPollInfo = Schema.Struct({
  worker: WorkerInfo,
  assignments: Schema.Array(WorkerAssignmentInfo),
  jobs: Schema.Array(WorkerJobAssignment),
  cancellations: Schema.Array(WorkerJobCancellation),
  settledJobs: Schema.Array(WorkerJobID),
  pollAfterMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(250)),
}).annotate({ identifier: "Work.WorkerPollInfo" })
export interface WorkerPollInfo extends Schema.Schema.Type<typeof WorkerPollInfo> {}

export const WorkerLeaseInfo = Schema.Struct({
  goalID: GoalID,
  workerID: WorkerID,
  controllerID: ControllerID.pipe(optional),
  controllerRuntimeID: ControllerRuntimeID.pipe(optional),
  ownerID: Schema.String,
  fence: NonNegativeInt,
  status: Schema.Literals(["active", "expired"]),
  expiresAt: DateTimeUtcFromMillis,
  updatedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Work.WorkerLeaseInfo" })
export interface WorkerLeaseInfo extends Schema.Schema.Type<typeof WorkerLeaseInfo> {}

export const GoalPlacementInfo = Schema.Struct({
  goalID: GoalID,
  workerID: WorkerID.pipe(optional),
  worker: WorkerInfo.pipe(optional),
  lease: WorkerLeaseInfo.pipe(optional),
  dispatch: ControllerDispatchInfo.pipe(optional),
}).annotate({ identifier: "Work.GoalPlacementInfo" })
export interface GoalPlacementInfo extends Schema.Schema.Type<typeof GoalPlacementInfo> {}

export const ReviewCriterion = Schema.Struct({
  criterionID: CriterionID,
  verdict: Verdict,
  findings: Schema.Array(Finding),
  allowsRepair: Schema.Boolean,
}).annotate({ identifier: "Work.ReviewCriterion" })
export interface ReviewCriterion extends Schema.Schema.Type<typeof ReviewCriterion> {}

export const ReviewOutput = Schema.Struct({
  criteria: Schema.Array(ReviewCriterion),
}).annotate({ identifier: "Work.ReviewOutput" })
export interface ReviewOutput extends Schema.Schema.Type<typeof ReviewOutput> {}

export const PlanIsolation = Schema.Literals(["shared", "worktree"]).annotate({
  identifier: "Work.PlanIsolation",
})
export type PlanIsolation = typeof PlanIsolation.Type

export const RoleID = Schema.Union(
  [Schema.String.check(Schema.isPattern(/^(?!work-)[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/))],
  { mode: "oneOf" },
).annotate({ identifier: "Work.RoleID" })
export type RoleID = typeof RoleID.Type

export const RoleCapability = Schema.Literals([
  "coordinate",
  "plan",
  "research",
  "design",
  "implement",
  "verify",
  "audit",
]).annotate({ identifier: "Work.RoleCapability" })
export type RoleCapability = typeof RoleCapability.Type

export const WorkspaceAccess = Schema.Literals(["read_only", "write"]).annotate({
  identifier: "Work.WorkspaceAccess",
})
export type WorkspaceAccess = typeof WorkspaceAccess.Type

export const RoleContract = Schema.Struct({
  id: RoleID,
  agentID: Schema.String,
  title: Schema.String,
  purpose: Schema.String,
  capabilities: Schema.Array(RoleCapability),
  workspaceAccess: WorkspaceAccess,
  allowedIsolation: Schema.Array(PlanIsolation),
  accepts: Schema.Array(HandoffItemKind),
  publishes: Schema.Array(HandoffItemKind),
}).annotate({ identifier: "Work.RoleContract" })
export interface RoleContract extends Schema.Schema.Type<typeof RoleContract> {}

export const PlanRole = Schema.Union(
  [Schema.String.check(Schema.isPattern(/^(?!work-)[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/))],
  { mode: "oneOf" },
).annotate({ identifier: "Work.PlanRole" })
export type PlanRole = typeof PlanRole.Type

export const PlanTask = Schema.Struct({
  key: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
  title: Schema.String,
  instructions: Schema.String,
  dependsOn: Schema.Array(Schema.String),
  role: PlanRole,
  isolation: PlanIsolation,
  criteria: Schema.Array(CriterionID),
}).annotate({ identifier: "Work.PlanTask" })
export interface PlanTask extends Schema.Schema.Type<typeof PlanTask> {}

export const PlanOutput = Schema.Struct({
  tasks: Schema.Array(PlanTask),
}).annotate({ identifier: "Work.PlanOutput" })
export interface PlanOutput extends Schema.Schema.Type<typeof PlanOutput> {}

export const ReplanOutput = Schema.Struct({
  supersedes: Schema.Array(TaskID),
  tasks: Schema.Array(PlanTask),
}).annotate({ identifier: "Work.ReplanOutput" })
export interface ReplanOutput extends Schema.Schema.Type<typeof ReplanOutput> {}
