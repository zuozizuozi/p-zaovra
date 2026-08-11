import { describe, expect } from "bun:test"
import { Work } from "@zaovra-ai/core/work"
import { Database } from "@zaovra-ai/core/database/database"
import { EventV2 } from "@zaovra-ai/core/event"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { WorkExecution } from "@zaovra-ai/core/work/execution"
import { WorkProjector } from "@zaovra-ai/core/work/projector"
import { WorkStore } from "@zaovra-ai/core/work/store"
import { WorkRole } from "@zaovra-ai/core/work/role"
import { DateTime, Effect, Exit, Layer } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, WorkProjector.node, WorkStore.node, Work.node]), [
    [WorkExecution.node, WorkExecution.noopLayer],
  ]),
)
const executionCalls = { wake: 0 }
const resumeIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, WorkProjector.node, WorkStore.node, Work.node]), [
    [
      WorkExecution.node,
      Layer.succeed(
        WorkExecution.Service,
        WorkExecution.Service.of({
          active: Effect.succeed(new Set()),
          resume: () => Effect.never,
          wake: () => Effect.sync(() => executionCalls.wake++),
          interrupt: () => Effect.void,
        }),
      ),
    ],
  ]),
)
const goalID = Work.GoalID.make("goal_test")
const location = { directory: AbsolutePath.make("/project") }
const input = {
  id: goalID,
  location,
  objective: "Implement durable execution",
  acceptanceCriteria: [{ description: "Tests pass", required: true, evidence: "test" as const }],
}

describe("Work.create", () => {
  resumeIt.effect("accepts resumable Goals asynchronously and rejects exhausted budgets", () =>
    Effect.gen(function* () {
      executionCalls.wake = 0
      const work = yield* Work.Service
      const events = yield* EventV2.Service
      yield* work.create(input)

      yield* work.resume(goalID)
      expect(executionCalls.wake).toBe(1)

      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: DateTime.makeUnsafe(2) })
      yield* events.publish(Work.Event.GoalBudgetExhausted, {
        goalID,
        reason: "Attempt budget exhausted",
        timestamp: DateTime.makeUnsafe(3),
      })
      const rejected = yield* work.resume(goalID).pipe(Effect.exit)

      expect(Exit.isFailure(rejected)).toBe(true)
      expect(executionCalls.wake).toBe(1)
    }),
  )

  it.effect("creates one deterministic Goal and default Task", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const created = yield* work.create(input)

      expect(created.goal).toMatchObject({
        id: goalID,
        status: "draft",
        acceptanceCriteria: [{ id: "criterion_test" }],
      })
      expect(created.tasks).toMatchObject([
        { id: "task_test", status: "pending", role: "build", criteria: ["criterion_test"] },
      ])
      expect(yield* work.list).toMatchObject([{ id: goalID, status: "draft" }])
    }),
  )

  it.effect("reconciles an exact retry without duplicating Tasks", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const first = yield* work.create(input)
      const second = yield* work.create(input)

      expect(second).toEqual(first)
      expect(yield* work.tasks(goalID)).toHaveLength(1)
    }),
  )

  it.effect("snapshots custom organization Role Contracts for deterministic replay", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const contract = Work.RoleContract.make({
        id: Work.RoleID.make("release-manager"),
        agentID: "release-manager",
        title: "Release Manager",
        purpose: "Prepare and validate releases",
        capabilities: ["coordinate", "verify"],
        workspaceAccess: "write",
        allowedIsolation: ["shared"],
        accepts: ["result", "risk"],
        publishes: ["result", "decision", "risk"],
      })
      const custom = {
        ...input,
        roleContracts: [...WorkRole.contracts, contract],
        tasks: [{ title: "Prepare release", instructions: "Prepare the release", role: contract.id }],
      }

      const first = yield* work.create(custom)
      const retried = yield* work.create({ ...custom, roleContracts: undefined })

      expect(first.goal.roleContracts).toContainEqual(contract)
      expect(first.tasks).toMatchObject([{ role: "release-manager" }])
      expect(retried).toEqual(first)
    }),
  )

  it.effect("atomically expands an active graph and reconciles an exact retry", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const events = yield* EventV2.Service
      yield* work.create(input)
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: DateTime.makeUnsafe(2) })
      const expansion = {
        goalID,
        tasks: [
          {
            id: Work.TaskID.make("task_test_followup"),
            title: "Follow up",
            instructions: "Use the initial implementation",
            dependsOn: [Work.TaskID.make("task_test")],
            criteria: [Work.CriterionID.make("criterion_test")],
          },
          {
            id: Work.TaskID.make("task_test_validation"),
            title: "Validate follow-up",
            instructions: "Validate the expanded work",
            dependsOn: [Work.TaskID.make("task_test_followup")],
            criteria: [Work.CriterionID.make("criterion_test")],
          },
        ],
      }

      const first = yield* work.expand(expansion)
      const second = yield* work.expand(expansion)

      expect(second).toEqual(first)
      expect(yield* work.tasks(goalID)).toHaveLength(3)
      expect(first).toMatchObject([
        { id: "task_test_followup", status: "pending", dependsOn: ["task_test"] },
        { id: "task_test_validation", status: "pending", dependsOn: ["task_test_followup"] },
      ])
    }),
  )

  it.effect("rejects a partial or invalid graph expansion without adding Tasks", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const events = yield* EventV2.Service
      yield* work.create(input)
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: DateTime.makeUnsafe(2) })

      const exit = yield* work
        .expand({
          goalID,
          tasks: [
            {
              id: Work.TaskID.make("task_invalid"),
              title: "Invalid",
              instructions: "Depend on an unknown Task",
              dependsOn: [Work.TaskID.make("task_missing")],
            },
          ],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* work.tasks(goalID)).toHaveLength(1)
    }),
  )

  it.effect("creates a durable Planner Task when planning is requested", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const created = yield* work.create({ ...input, planning: true })

      expect(created.tasks).toMatchObject([{ id: "task_test", role: "work-planner", status: "pending", criteria: [] }])
      expect(yield* work.create({ ...input, planning: true })).toEqual(created)
    }),
  )

  it.effect("durably requests one idempotent Architect replan and reactivates a blocked Goal", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const events = yield* EventV2.Service
      yield* work.create(input)
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: DateTime.makeUnsafe(2) })
      yield* events.publish(Work.Event.TaskReadied, {
        goalID,
        taskID: Work.TaskID.make("task_test"),
        status: "ready",
        timestamp: DateTime.makeUnsafe(3),
      })
      yield* events.publish(Work.Event.TaskStarted, {
        goalID,
        taskID: Work.TaskID.make("task_test"),
        status: "running",
        timestamp: DateTime.makeUnsafe(4),
      })
      yield* events.publish(Work.Event.TaskBlocked, {
        goalID,
        taskID: Work.TaskID.make("task_test"),
        status: "blocked",
        reason: "No progress",
        timestamp: DateTime.makeUnsafe(5),
      })
      yield* events.publish(Work.Event.GoalBlocked, {
        goalID,
        reason: "No progress",
        timestamp: DateTime.makeUnsafe(6),
      })
      const request = {
        goalID,
        taskID: Work.TaskID.make("task_architect"),
        reason: "Try a different architecture",
      }

      const first = yield* work.requestReplan(request)
      const second = yield* work.requestReplan(request)

      expect(second).toEqual(first)
      expect(first).toMatchObject({ role: "work-architect", status: "pending", criteria: [] })
      expect(yield* work.get(goalID)).toMatchObject({ status: "active" })
      expect(yield* work.tasks(goalID)).toHaveLength(2)
    }),
  )

  it.effect("rejects direct injection of Architect runtime Tasks", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const exit = yield* work
        .create({
          ...input,
          tasks: [{ title: "Bypass", instructions: "Bypass the runtime", role: "work-architect" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("rejects combining planning with an explicit Task graph", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const exit = yield* work
        .create({
          ...input,
          planning: true,
          tasks: [{ title: "Explicit", instructions: "Do explicit work" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* work.get(goalID).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
    }),
  )

  it.effect("completes a retry after Goal creation was interrupted before Task creation", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const events = yield* EventV2.Service
      const timestamp = DateTime.makeUnsafe(1)
      yield* events.publish(Work.Event.GoalCreated, {
        goalID,
        timestamp,
        info: Work.GoalInfo.make({
          id: goalID,
          location,
          objective: input.objective,
          acceptanceCriteria: [
            {
              id: Work.CriterionID.make("criterion_test"),
              description: "Tests pass",
              required: true,
              evidence: "test",
            },
          ],
          status: "draft",
          usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
          time: { created: timestamp, updated: timestamp },
          revision: 0,
        }),
      })

      expect((yield* work.create(input)).tasks).toMatchObject([{ id: "task_test" }])
    }),
  )

  it.effect("rejects conflicting reuse of one Goal ID", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      yield* work.create(input)

      const exit = yield* work.create({ ...input, objective: "Different work" }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* work.get(goalID)).toMatchObject({ objective: input.objective })
    }),
  )

  it.effect("rejects changing the Task graph during an exact retry", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      yield* work.create(input)

      const exit = yield* work
        .create({
          ...input,
          tasks: [
            {
              id: Work.TaskID.make("task_different"),
              title: "Different Task",
              instructions: "Different instructions",
            },
          ],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* work.tasks(goalID)).toMatchObject([{ id: "task_test" }])
    }),
  )

  it.effect("validates and topologically orders a Task graph before persistence", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const firstID = Work.TaskID.make("task_first")
      const secondID = Work.TaskID.make("task_second")
      const created = yield* work.create({
        ...input,
        tasks: [
          { id: secondID, title: "Second", instructions: "Run second", dependsOn: [firstID] },
          { id: firstID, title: "First", instructions: "Run first" },
        ],
      })

      expect(created.tasks.map((task) => task.id)).toEqual([firstID, secondID])
    }),
  )

  it.effect("rejects a cyclic Task graph without creating a partial Goal", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const firstID = Work.TaskID.make("task_cycle_first")
      const secondID = Work.TaskID.make("task_cycle_second")
      const exit = yield* work
        .create({
          ...input,
          tasks: [
            { id: firstID, title: "First", instructions: "Run first", dependsOn: [secondID] },
            { id: secondID, title: "Second", instructions: "Run second", dependsOn: [firstID] },
          ],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* work.get(goalID).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
    }),
  )

  it.effect("pauses and cancels through durable state transitions", () =>
    Effect.gen(function* () {
      const work = yield* Work.Service
      const events = yield* EventV2.Service
      yield* work.create(input)
      yield* events.publish(Work.Event.GoalActivated, { goalID, timestamp: DateTime.makeUnsafe(2) })

      yield* work.pause(goalID)
      expect(yield* work.get(goalID)).toMatchObject({ status: "paused" })
      yield* work.cancel(goalID, "user cancelled")
      expect(yield* work.get(goalID)).toMatchObject({ status: "cancelled" })
      expect(yield* work.tasks(goalID)).toMatchObject([{ status: "cancelled" }])
    }),
  )
})
