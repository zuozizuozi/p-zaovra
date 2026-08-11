import { Schema } from "effect"
import { ascending } from "./identifier"
import { statics } from "./schema"

function id<const Brand extends string>(prefix: string, brand: Brand) {
  return Schema.String.check(Schema.isStartsWith(prefix)).pipe(
    Schema.brand(brand),
    statics((schema) => ({ create: () => schema.make(prefix + ascending()) })),
  )
}

export const GoalID = id("goal_", "Work.GoalID")
export type GoalID = typeof GoalID.Type

export const TaskID = id("task_", "Work.TaskID")
export type TaskID = typeof TaskID.Type

export const AttemptID = id("attempt_", "Work.AttemptID")
export type AttemptID = typeof AttemptID.Type

export const CriterionID = id("criterion_", "Work.CriterionID")
export type CriterionID = typeof CriterionID.Type

export const EvidenceID = id("evidence_", "Work.EvidenceID")
export type EvidenceID = typeof EvidenceID.Type

export const EvaluationID = id("evaluation_", "Work.EvaluationID")
export type EvaluationID = typeof EvaluationID.Type

export const HandoffID = id("handoff_", "Work.HandoffID")
export type HandoffID = typeof HandoffID.Type

export const MemoryResolutionID = id("memory_resolution_", "Work.MemoryResolutionID")
export type MemoryResolutionID = typeof MemoryResolutionID.Type

export const WorkerID = id("worker_", "Work.WorkerID")
export type WorkerID = typeof WorkerID.Type

export const WorkerRuntimeID = id("worker_runtime_", "Work.WorkerRuntimeID")
export type WorkerRuntimeID = typeof WorkerRuntimeID.Type

export const WorkerJobID = id("worker_job_", "Work.WorkerJobID")
export type WorkerJobID = typeof WorkerJobID.Type

export const ControllerID = id("controller_", "Work.ControllerID")
export type ControllerID = typeof ControllerID.Type

export const ControllerRuntimeID = id("controller_runtime_", "Work.ControllerRuntimeID")
export type ControllerRuntimeID = typeof ControllerRuntimeID.Type
