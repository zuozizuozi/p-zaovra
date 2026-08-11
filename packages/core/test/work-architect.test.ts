import { describe, expect } from "bun:test"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { WorkArchitect } from "@zaovra-ai/core/work/architect"
import { Work } from "@zaovra-ai/schema/work"
import { DateTime, Effect, Exit } from "effect"
import { it } from "./lib/effect"

const criterionID = Work.CriterionID.make("criterion_architect")
const goal = Work.GoalInfo.make({
  id: Work.GoalID.make("goal_architect"),
  location: { directory: AbsolutePath.make("/project") },
  objective: "Recover durable work",
  acceptanceCriteria: [{ id: criterionID, description: "Recovery passes review", required: true, evidence: "review" }],
  status: "active",
  usage: { attempts: 1, repairs: 1, turns: 0, cost: 0 },
  time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
  revision: 2,
})
const architect = task("task_architect", "running", "work-architect", [])
const blocked = task("task_blocked", "blocked", "build", [criterionID])
const completed = task("task_completed", "completed", "build", [])

describe("WorkArchitect", () => {
  it.effect("parses and validates a stable additive recovery DAG", () =>
    Effect.gen(function* () {
      const output = yield* WorkArchitect.parse(`\`\`\`json
{"supersedes":["task_blocked"],"tasks":[{"key":"verify","title":"Verify recovery","instructions":"Verify the corrected implementation","dependsOn":["implement"],"role":"explore","isolation":"shared","criteria":["criterion_architect"]},{"key":"implement","title":"Implement recovery","instructions":"Address the failed approach","dependsOn":["task_completed"],"role":"build","isolation":"worktree","criteria":["criterion_architect"]}]}
\`\`\``)
      const first = yield* WorkArchitect.validate(goal, architect, [blocked, completed, architect], output)
      const second = yield* WorkArchitect.validate(goal, architect, [blocked, completed, architect], output)

      expect(first.supersededTaskIDs).toEqual([blocked.id])
      expect(first.tasks.map((item) => item.title)).toEqual(["Implement recovery", "Verify recovery"])
      expect(first.tasks.map((item) => item.id)).toEqual(second.tasks.map((item) => item.id))
      expect(first.tasks[0]?.dependsOn).toEqual([completed.id])
      expect(first.tasks[1]?.dependsOn).toEqual([first.tasks[0]?.id])
    }),
  )

  it.effect("rejects live dependencies and lost superseded criteria", () =>
    Effect.gen(function* () {
      const liveDependency = Work.ReplanOutput.make({
        supersedes: [blocked.id],
        tasks: [planTask({ dependsOn: [architect.id] })],
      })
      const lostCriterion = Work.ReplanOutput.make({
        supersedes: [blocked.id],
        tasks: [planTask({ criteria: [] })],
      })

      expect(
        Exit.isFailure(
          yield* WorkArchitect.validate(goal, architect, [blocked, completed, architect], liveDependency).pipe(
            Effect.exit,
          ),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* WorkArchitect.validate(goal, architect, [blocked, completed, architect], lostCriterion).pipe(
            Effect.exit,
          ),
        ),
      ).toBe(true)
    }),
  )
})

function task(id: string, status: Work.TaskStatus, role: string, criteria: ReadonlyArray<Work.CriterionID>) {
  return Work.TaskInfo.make({
    id: Work.TaskID.make(id),
    goalID: goal.id,
    title: id,
    instructions: id,
    dependsOn: [],
    role,
    status,
    criteria,
    attemptCount: 0,
    time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
    revision: 0,
  })
}

function planTask(input: { dependsOn?: ReadonlyArray<string>; criteria?: ReadonlyArray<Work.CriterionID> }) {
  return {
    key: "recovery",
    title: "Recovery",
    instructions: "Recover",
    dependsOn: input.dependsOn ?? [],
    role: "build" as const,
    isolation: "shared" as const,
    criteria: input.criteria ?? [criterionID],
  }
}
