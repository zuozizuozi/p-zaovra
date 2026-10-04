export * as WorkAcceptance from "./acceptance"

import { Work } from "@zaovra-ai/schema/work"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import { SessionOutcome } from "../session/outcome"
import { Hash } from "../util/hash"
import type { WorkPlanner } from "./planner"
import { WorkRole } from "./role"

export function criteria(goal: Work.GoalInfo, task: Work.TaskInfo) {
  return (
    task.acceptance?.criteria ?? goal.acceptanceCriteria.filter((criterion) => task.criteria.includes(criterion.id))
  )
}

/** Called only when admitting a new plan; stored legacy graphs keep their original contract. */
export function plan(goal: Work.GoalInfo, tasks: ReadonlyArray<WorkPlanner.ValidatedTask>) {
  const qa = WorkRole.get("qa", goal.roleContracts ?? WorkRole.contracts)
  if (!qa || qa.agentID !== "work-qa" || qa.workspaceAccess !== "read_only" || !qa.allowedIsolation.includes("shared"))
    throw new Error("Final acceptance requires the read-only work-qa role")
  const terminal = tasks.findLast(
    (task) => task.role === "qa" && !tasks.some((other) => other.dependsOn.includes(task.id)),
  )
  const business = tasks
    .filter((task) => task !== terminal)
    .map((task) => {
      const acceptance = local(task)
      const assigned = acceptance.criteria
      return {
        ...task,
        criteria: assigned.map((criterion) => criterion.id),
        acceptance,
      }
    })
  // An all-QA plan still needs a real business task; do not silently discard its scope.
  if (!business.length && terminal)
    return plan(
      goal,
      tasks.map((task) => ({ ...task, role: "explore" })),
    )
  if (business.length >= 24) throw new Error("Plan must leave room for final acceptance within the 24 Task limit")
  return [
    ...business,
    {
      id: terminal?.id ?? Work.TaskID.make(`task_${Hash.sha256(`${goal.id}:host-final-acceptance`).slice(0, 24)}`),
      title: "Final acceptance",
      instructions: `${terminal?.instructions ?? ""}\n\nVerify the completed Goal against its original acceptance criteria and the current artifacts. Read code and evidence; the host runs declared verifiers. Do not implement, edit files, or invent new requirements. Attribute failures to the responsible business taskID in each finding. The host routes repairs back to business Tasks.`,
      dependsOn: business.map((task) => task.id),
      role: "qa",
      isolation: "shared" as const,
      criteria: goal.acceptanceCriteria.map((criterion) => criterion.id),
      acceptance: { scope: "final" as const, criteria: goal.acceptanceCriteria },
    },
  ] satisfies ReadonlyArray<WorkPlanner.ValidatedTask>
}

export function local(task: {
  id: Work.TaskID
  instructions: string
  localAcceptance?: ReadonlyArray<string>
}): Work.TaskAcceptance {
  return {
    scope: "local",
    criteria: (task.localAcceptance?.length ? task.localAcceptance : [task.instructions]).map((description, index) => ({
      id: Work.CriterionID.make(`criterion_local_${Hash.sha256(`${task.id}:${index}:${description}`).slice(0, 24)}`),
      description,
      required: true,
      evidence: "review",
    })),
  }
}

export function valid(
  goal: ReadonlyArray<Work.Criterion>,
  task: Pick<Work.TaskInfo, "id" | "criteria" | "acceptance" | "role">,
) {
  if (!task.acceptance) return task.criteria.every((id) => goal.some((criterion) => criterion.id === id))
  const assigned = task.acceptance.criteria
  if (
    (task.acceptance.scope === "local" && !assigned.length) ||
    new Set(assigned.map((criterion) => criterion.id)).size !== assigned.length ||
    assigned.length !== task.criteria.length ||
    assigned.some((criterion) => !task.criteria.includes(criterion.id))
  )
    return false
  if (task.acceptance.scope === "final") return task.role === "qa" && JSON.stringify(assigned) === JSON.stringify(goal)
  return assigned.every(
    (criterion) =>
      criterion.required &&
      !criterion.verifier &&
      criterion.evidence === "review" &&
      criterion.id.startsWith("criterion_local_") &&
      !goal.some((global) => global.id === criterion.id),
  )
}

export function validGraph(goal: ReadonlyArray<Work.Criterion>, tasks: ReadonlyArray<Work.TaskInfo>) {
  if (!tasks.some((task) => task.acceptance)) return true
  const finals = tasks.filter((task) => task.acceptance?.scope === "final")
  return (
    finals.length === 1 &&
    tasks.every((task) => !!task.acceptance && valid(goal, task)) &&
    tasks.filter((task) => task !== finals[0]).every((task) => finals[0]!.dependsOn.includes(task.id)) &&
    new Set(tasks.flatMap((task) => task.criteria)).size ===
      tasks.reduce((count, task) => count + task.criteria.length, 0)
  )
}

/** A review receipt covers the deliverable tree, including untracked and generated files.
 * Dependency stores and VCS internals are not deliverables. Unreadable files fail closed.
 */
export const fingerprint = Effect.fn("WorkAcceptance.fingerprint")(function* (fs: FSUtil.Interface, directory: string) {
  const walk = (directory: string): Effect.Effect<string[], FSUtil.Error> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectoryEntries(directory)
      return (yield* Effect.forEach(
        entries.filter((entry) => ![".git", "node_modules"].includes(entry.name)),
        (entry) =>
          entry.type === "directory"
            ? walk(path.join(directory, entry.name))
            : Effect.succeed([path.join(directory, entry.name)]),
      )).flat()
    })
  return yield* walk(directory).pipe(
    Effect.flatMap((files) => SessionOutcome.fingerprint(fs, files.toSorted())),
    Effect.map((files) => (files.some((file) => !file.digest) ? undefined : Hash.sha256(JSON.stringify(files)))),
    Effect.catch(() => Effect.succeed(undefined)),
  )
})
