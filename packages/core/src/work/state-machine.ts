export * as WorkStateMachine from "./state-machine"

import type { Work } from "@zaovra-ai/schema/work"

export class InvalidTransitionError extends Error {
  constructor(
    readonly entity: "goal" | "task" | "attempt",
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid ${entity} transition from ${from} to ${to}`)
  }
}

const goalTransitions = {
  draft: ["active", "cancelling"],
  active: ["pausing", "completed", "blocked", "cancelling", "budget_exhausted"],
  pausing: ["paused", "blocked", "cancelling"],
  paused: ["active", "blocked", "cancelling", "budget_exhausted"],
  cancelling: ["cancelled"],
  blocked: ["active", "cancelling"],
  completed: [],
  cancelled: [],
  budget_exhausted: ["active", "cancelling"],
} satisfies Record<Work.GoalStatus, Work.GoalStatus[]>

const taskTransitions = {
  pending: ["ready", "blocked", "cancelled"],
  ready: ["running", "blocked", "cancelled"],
  running: ["verifying", "rework", "blocked", "cancelled"],
  verifying: ["reviewing", "merging", "rework", "completed", "blocked", "cancelled"],
  reviewing: ["merging", "rework", "completed", "blocked", "cancelled"],
  merging: ["completed", "blocked", "cancelled"],
  rework: ["running", "blocked", "cancelled"],
  completed: [],
  blocked: ["rework", "superseded"],
  superseded: [],
  cancelled: [],
} satisfies Record<Work.TaskStatus, Work.TaskStatus[]>

const attemptTransitions = {
  admitted: ["running", "failed", "interrupted", "unknown", "cancelled"],
  running: ["succeeded", "failed", "interrupted", "unknown", "cancelled"],
  succeeded: [],
  failed: [],
  interrupted: [],
  unknown: [],
  cancelled: [],
} satisfies Record<Work.AttemptStatus, Work.AttemptStatus[]>

export function goal(from: Work.GoalStatus, to: Work.GoalStatus) {
  if (!goalTransitions[from].some((status) => status === to)) throw new InvalidTransitionError("goal", from, to)
}

export function task(from: Work.TaskStatus, to: Work.TaskStatus) {
  if (!taskTransitions[from].some((status) => status === to)) throw new InvalidTransitionError("task", from, to)
}

export function attempt(from: Work.AttemptStatus, to: Work.AttemptStatus) {
  if (!attemptTransitions[from].some((status) => status === to)) throw new InvalidTransitionError("attempt", from, to)
}

export function isGoalTerminal(status: Work.GoalStatus) {
  return status === "completed" || status === "cancelled" || status === "budget_exhausted"
}

export function isTaskTerminal(status: Work.TaskStatus) {
  return status === "completed" || status === "blocked" || status === "superseded" || status === "cancelled"
}

export function isAttemptTerminal(status: Work.AttemptStatus) {
  return status !== "admitted" && status !== "running"
}
