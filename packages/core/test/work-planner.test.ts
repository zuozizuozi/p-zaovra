import { describe, expect } from "bun:test"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { WorkPlanner } from "@zaovra-ai/core/work/planner"
import { Work } from "@zaovra-ai/schema/work"
import { DateTime, Effect, Exit } from "effect"
import { it } from "./lib/effect"

const goal = Work.GoalInfo.make({
  id: Work.GoalID.make("goal_planner"),
  location: { directory: AbsolutePath.make("/project") },
  objective: "Implement durable planning",
  acceptanceCriteria: [
    {
      id: Work.CriterionID.make("criterion_planner"),
      description: "Planning is durable",
      required: true,
      evidence: "review",
    },
  ],
  status: "active",
  usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
  time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
  revision: 0,
})

describe("WorkPlanner", () => {
  it.effect("parses fenced JSON and validates a stable topological graph", () =>
    Effect.gen(function* () {
      const output = yield* WorkPlanner.parse(`\`\`\`json
{"tasks":[{"key":"verify","title":"Verify","instructions":"Run checks","dependsOn":["implement"],"role":"explore","isolation":"shared","criteria":["criterion_planner"]},{"key":"implement","title":"Implement","instructions":"Write code","dependsOn":[],"role":"build","isolation":"worktree","criteria":["criterion_planner"]}]}
\`\`\``)
      const first = yield* WorkPlanner.validate(goal, output)
      const second = yield* WorkPlanner.validate(goal, output)

      expect(first.map((task) => task.title)).toEqual(["Implement", "Verify"])
      expect(first.map((task) => task.id)).toEqual(second.map((task) => task.id))
      expect(first[1]?.dependsOn).toEqual([first[0]?.id])
    }),
  )

  it.effect("validates organization roles against their isolation contracts", () =>
    Effect.gen(function* () {
      const output = Work.PlanOutput.make({
        tasks: [
          {
            key: "design",
            title: "Design",
            instructions: "Define the boundary",
            dependsOn: [],
            role: "architect",
            isolation: "shared",
            criteria: [Work.CriterionID.make("criterion_planner")],
          },
          {
            key: "implement",
            title: "Implement",
            instructions: "Implement the design",
            dependsOn: ["design"],
            role: "developer",
            isolation: "worktree",
            criteria: [Work.CriterionID.make("criterion_planner")],
          },
          {
            key: "quality",
            title: "Review quality",
            instructions: "Challenge the result",
            dependsOn: ["implement"],
            role: "qa",
            isolation: "shared",
            criteria: [Work.CriterionID.make("criterion_planner")],
          },
        ],
      })

      expect((yield* WorkPlanner.validate(goal, output)).map((task) => task.role)).toEqual([
        "architect",
        "developer",
        "qa",
      ])
    }),
  )

  it.effect("rejects cycles and missing required criterion coverage", () =>
    Effect.gen(function* () {
      const cycle = Work.PlanOutput.make({
        tasks: [
          {
            key: "a",
            title: "A",
            instructions: "A",
            dependsOn: ["b"],
            role: "build",
            isolation: "shared",
            criteria: [Work.CriterionID.make("criterion_planner")],
          },
          {
            key: "b",
            title: "B",
            instructions: "B",
            dependsOn: ["a"],
            role: "build",
            isolation: "shared",
            criteria: [Work.CriterionID.make("criterion_planner")],
          },
        ],
      })
      const uncovered = Work.PlanOutput.make({
        tasks: [
          {
            key: "a",
            title: "A",
            instructions: "A",
            dependsOn: [],
            role: "build",
            isolation: "shared",
            criteria: [],
          },
        ],
      })
      const writableExplore = Work.PlanOutput.make({
        tasks: [
          {
            key: "research",
            title: "Research",
            instructions: "Inspect only",
            dependsOn: [],
            role: "explore",
            isolation: "worktree",
            criteria: [Work.CriterionID.make("criterion_planner")],
          },
        ],
      })
      const writableQA = Work.PlanOutput.make({
        tasks: [
          {
            key: "qa",
            title: "QA",
            instructions: "Review only",
            dependsOn: [],
            role: "qa",
            isolation: "worktree",
            criteria: [Work.CriterionID.make("criterion_planner")],
          },
        ],
      })

      expect(Exit.isFailure(yield* WorkPlanner.validate(goal, cycle).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* WorkPlanner.validate(goal, uncovered).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* WorkPlanner.validate(goal, writableExplore).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* WorkPlanner.validate(goal, writableQA).pipe(Effect.exit))).toBe(true)
    }),
  )
})
