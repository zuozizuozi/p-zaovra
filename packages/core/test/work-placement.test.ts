import { describe, expect } from "bun:test"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { Work } from "@zaovra-ai/core/work"
import { WorkLease } from "@zaovra-ai/core/work/lease"
import { WorkPlacement } from "@zaovra-ai/core/work/placement"
import { WorkProjector } from "@zaovra-ai/core/work/projector"
import { WorkStore } from "@zaovra-ai/core/work/store"
import { WorkWorker } from "@zaovra-ai/core/work/worker"
import { DateTime, Effect, Exit } from "effect"
import { testEffect } from "./lib/effect"

const workerA = Work.WorkerID.make("worker_a")
const workerB = Work.WorkerID.make("worker_b")
const workerC = Work.WorkerID.make("worker_c")
const workerD = Work.WorkerID.make("worker_d")
const goalID = Work.GoalID.make("goal_placement")
const location = { directory: AbsolutePath.make("/project") }
const workerLayer = WorkWorker.makeLayer({
  local: {
    id: workerA,
    label: "Worker A",
    capabilities: ["execute", "worktree", "mcp"],
    workspaceRoots: ["*"],
  },
  automatic: false,
})
const leaseLayer = WorkLease.makeLayer({ workerID: workerA, ownerID: "worker-a-runtime" })
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      WorkProjector.node,
      WorkStore.node,
      WorkWorker.node,
      WorkLease.node,
      WorkPlacement.node,
    ]),
    [
      [WorkWorker.node, workerLayer],
      [WorkLease.node, leaseLayer],
    ],
  ),
)

describe("WorkPlacement", () => {
  it.effect("fences Goal ownership to its assigned Worker and audits safe reassignment", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const placement = yield* WorkPlacement.Service
      const store = yield* WorkStore.Service
      const workers = yield* WorkWorker.Service
      const timestamp = DateTime.makeUnsafe(1)
      yield* events.publish(Work.Event.GoalCreated, {
        goalID,
        timestamp,
        info: Work.GoalInfo.make({
          id: goalID,
          location,
          objective: "Execute on one assigned Worker",
          acceptanceCriteria: [],
          status: "draft",
          usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
          time: { created: timestamp, updated: timestamp },
          revision: 0,
        }),
      })
      yield* workers.heartbeat({
        id: workerB,
        label: "Worker B",
        capabilities: ["execute"],
        workspaceRoots: ["/project"],
      })

      expect(yield* placement.assign({ goalID, workerID: workerB, reason: "Move execution" })).toMatchObject({
        workerID: workerB,
        worker: { status: "online" },
      })
      expect(yield* store.getGoal(goalID)).toMatchObject({ workerID: workerB })

      const blocked = yield* WorkLease.Service.use((lease) => lease.run(goalID, (claim) => Effect.succeed(claim)))
      expect(blocked).toBeUndefined()

      const activeReassignment = yield* WorkLease.Service.use((lease) =>
        lease.run(goalID, () => placement.assign({ goalID, workerID: workerA }).pipe(Effect.exit)),
      ).pipe(Effect.provide(WorkLease.makeLayer({ workerID: workerB, ownerID: "worker-b-runtime" })))
      expect(activeReassignment).toMatchObject({ _tag: "Failure" })

      expect(
        yield* placement.assign({ goalID, workerID: workerA, reason: "Worker B released its lease" }),
      ).toMatchObject({ workerID: workerA, lease: { status: "expired", fence: 1 } })
      expect(yield* placement.release(goalID, "Return to the unassigned queue")).toMatchObject({
        workerID: undefined,
      })

      yield* workers.heartbeat({
        id: workerC,
        label: "Remote Worker C",
        capabilities: ["execute"],
        workspaceRoots: ["/srv/project"],
        executionMode: "remote",
        locationMappings: [{ controllerRoot: "/project", workerRoot: "/srv/project" }],
      })
      expect(yield* placement.assign({ goalID, workerID: workerC })).toMatchObject({
        workerID: workerC,
        worker: { executionMode: "remote" },
      })
      expect(yield* placement.release(goalID)).toMatchObject({ workerID: undefined })

      yield* workers.heartbeat({
        id: workerD,
        label: "Remote Worker D",
        capabilities: ["execute"],
        workspaceRoots: ["/srv/other"],
        executionMode: "remote",
        locationMappings: [{ controllerRoot: "/other", workerRoot: "/srv/other" }],
      })
      expect(Exit.isFailure(yield* placement.assign({ goalID, workerID: workerD }).pipe(Effect.exit))).toBeTrue()
      expect(Exit.isSuccess(yield* placement.info(goalID).pipe(Effect.exit))).toBe(true)
    }),
  )
})
