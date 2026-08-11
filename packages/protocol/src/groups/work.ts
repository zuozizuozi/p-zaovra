import { Location } from "@zaovra-ai/schema/location"
import { Work } from "@zaovra-ai/schema/work"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, WorkNotFoundError } from "../errors"

export const WorkCriterionInput = Schema.Struct({
  id: Work.CriterionID.pipe(Schema.optional),
  description: Schema.String,
  required: Schema.Boolean,
  evidence: Work.EvidenceKind,
  verifier: Work.Verifier.pipe(Schema.optional),
}).annotate({ identifier: "WorkCriterionInput" })

export const WorkTaskInput = Schema.Struct({
  id: Work.TaskID.pipe(Schema.optional),
  title: Schema.String,
  instructions: Schema.String,
  dependsOn: Schema.Array(Work.TaskID).pipe(Schema.optional),
  role: Work.RoleID.pipe(Schema.optional),
  location: Location.Ref.pipe(Schema.optional),
  criteria: Schema.Array(Work.CriterionID).pipe(Schema.optional),
}).annotate({ identifier: "WorkTaskInput" })

export const WorkCreateInput = Schema.Struct({
  id: Work.GoalID.pipe(Schema.optional),
  location: Location.Ref,
  objective: Schema.String,
  acceptanceCriteria: Schema.Array(WorkCriterionInput),
  budget: Work.Budget.pipe(Schema.optional),
  planning: Schema.Boolean.pipe(Schema.optional),
  tasks: Schema.Array(WorkTaskInput).pipe(Schema.optional),
}).annotate({ identifier: "WorkCreateInput" })

export const WorkExpandTaskInput = Schema.Struct({
  id: Work.TaskID,
  title: Schema.String,
  instructions: Schema.String,
  dependsOn: Schema.Array(Work.TaskID).pipe(Schema.optional),
  role: Work.RoleID.pipe(Schema.optional),
  location: Location.Ref.pipe(Schema.optional),
  criteria: Schema.Array(Work.CriterionID).pipe(Schema.optional),
}).annotate({ identifier: "WorkExpandTaskInput" })

export const WorkExpandInput = Schema.Struct({
  tasks: Schema.Array(WorkExpandTaskInput),
}).annotate({ identifier: "WorkExpandInput" })

export const WorkReplanInput = Schema.Struct({
  taskID: Work.TaskID,
  reason: Schema.String,
}).annotate({ identifier: "WorkReplanInput" })

export const WorkResolveMemoryInput = Schema.Struct({
  key: Schema.String,
  handoffID: Work.HandoffID,
  itemDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  reason: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "WorkResolveMemoryInput" })

export const WorkUpdateMemoryInput = Schema.Struct({
  kind: Work.HandoffItemKind,
  text: Schema.String,
  reference: Schema.String.pipe(Schema.optional),
  reason: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "WorkUpdateMemoryInput" })

export const WorkDetail = Schema.Struct({
  goal: Work.GoalInfo,
  tasks: Schema.Array(Work.TaskInfo),
  attempts: Schema.Array(Work.AttemptInfo),
  evidence: Schema.Array(Work.EvidenceInfo),
  evaluations: Schema.Array(Work.EvaluationInfo),
  handoffs: Schema.Array(Work.HandoffInfo),
  roles: Schema.Array(Work.RoleContract),
  memory: Work.ProjectMemoryView,
}).annotate({ identifier: "WorkDetail" })

const WorkActive = Schema.Struct({ type: Schema.Literal("running") }).annotate({ identifier: "WorkActive" })

export const WorkGroup = HttpApiGroup.make("server.work")
  .add(
    HttpApiEndpoint.get("work.list", "/api/work", {
      success: Schema.Struct({ data: Schema.Array(Work.GoalInfo) }),
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.work.list", summary: "List durable work" })),
  )
  .add(
    HttpApiEndpoint.post("work.create", "/api/work", {
      payload: WorkCreateInput,
      success: Schema.Struct({ data: WorkDetail }),
      error: [ConflictError, WorkNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.work.create",
        summary: "Create durable work",
        description:
          "Create one durable Goal and either an initial Task graph or a durable Planner Task without starting execution.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("work.active", "/api/work/active", {
      success: Schema.Struct({ data: Schema.Record(Work.GoalID, WorkActive) }),
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.work.active", summary: "List active Goal drains" })),
  )
  .add(
    HttpApiEndpoint.get("work.artifacts", "/api/work/artifacts", {
      success: Schema.Struct({ data: Schema.Array(Work.ArtifactLifecycleInfo) }),
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.work.artifacts", summary: "Inspect managed WorkGraph artifacts" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("work.artifactCollect", "/api/work/artifacts/collect", {
      payload: Schema.Struct({
        minimumAgeMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(60_000)),
        dryRun: Schema.Boolean,
        limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })).pipe(Schema.optional),
      }),
      success: Schema.Struct({ data: Work.ArtifactCollectionReport }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.work.artifactCollect",
        summary: "Collect unreferenced WorkGraph artifacts",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("work.get", "/api/work/:goalID", {
      params: { goalID: Work.GoalID },
      success: Schema.Struct({ data: WorkDetail }),
      error: WorkNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.work.get", summary: "Get durable work state" })),
  )
  .add(
    HttpApiEndpoint.post("work.expand", "/api/work/:goalID/tasks", {
      params: { goalID: Work.GoalID },
      payload: WorkExpandInput,
      success: Schema.Struct({ data: WorkDetail }),
      error: [ConflictError, WorkNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.work.expand",
        summary: "Expand a durable Task graph",
        description: "Atomically add an idempotent Task DAG fragment while a Goal is active or paused.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("work.replan", "/api/work/:goalID/replan", {
      params: { goalID: Work.GoalID },
      payload: WorkReplanInput,
      success: Schema.Struct({ data: WorkDetail }),
      error: [ConflictError, WorkNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.work.replan",
        summary: "Request an Architect replan",
        description:
          "Durably admit an independent Architect Task that can supersede blocked Tasks with an additive recovery DAG.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("work.resume", "/api/work/:goalID/resume", {
      params: { goalID: Work.GoalID },
      success: HttpApiSchema.NoContent,
      error: [WorkNotFoundError, ConflictError],
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.work.resume", summary: "Run or resume durable work" })),
  )
  .add(
    HttpApiEndpoint.post("work.pause", "/api/work/:goalID/pause", {
      params: { goalID: Work.GoalID },
      success: HttpApiSchema.NoContent,
      error: WorkNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.work.pause", summary: "Pause durable work" })),
  )
  .add(
    HttpApiEndpoint.post("work.cancel", "/api/work/:goalID/cancel", {
      params: { goalID: Work.GoalID },
      payload: Schema.Struct({ reason: Schema.String.pipe(Schema.optional) }),
      success: HttpApiSchema.NoContent,
      error: WorkNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.work.cancel", summary: "Cancel durable work" })),
  )
  .add(
    HttpApiEndpoint.post("work.resolveUnknown", "/api/work/:goalID/attempt/:attemptID/resolve", {
      params: { goalID: Work.GoalID, attemptID: Work.AttemptID },
      payload: Schema.Struct({ resolution: Schema.Literal("retry"), reason: Schema.String.pipe(Schema.optional) }),
      success: HttpApiSchema.NoContent,
      error: [WorkNotFoundError, ConflictError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.work.resolveUnknown",
        summary: "Authorize retry after an unknown Attempt",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("work.resolveMemory", "/api/work/:goalID/memory/resolve", {
      params: { goalID: Work.GoalID },
      payload: WorkResolveMemoryInput,
      success: Schema.Struct({ data: WorkDetail }),
      error: [WorkNotFoundError, ConflictError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.work.resolveMemory",
        summary: "Resolve a governed project-memory conflict",
        description: "Durably select one active, evidence-linked memory candidate and retain an audit record.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("work.updateMemory", "/api/work/:goalID/memory/:key", {
      params: { goalID: Work.GoalID, key: Schema.String },
      payload: WorkUpdateMemoryInput,
      success: Schema.Struct({ data: WorkDetail }),
      error: [WorkNotFoundError, ConflictError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.work.updateMemory",
        summary: "Supersede a project-memory value",
        description: "Record an audited user correction without rewriting the source Handoff.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("work.deleteMemory", "/api/work/:goalID/memory/:key", {
      params: { goalID: Work.GoalID, key: Schema.String },
      success: Schema.Struct({ data: WorkDetail }),
      error: [WorkNotFoundError, ConflictError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.work.deleteMemory",
        summary: "Delete a project-memory value",
        description: "Record an audited tombstone while retaining the historical source Handoff.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "work",
      description: "Durable Goal, Task, Attempt, Evidence, Evaluation, and Handoff control plane.",
    }),
  )
