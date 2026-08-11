import { describe, expect } from "bun:test"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { Work } from "@zaovra-ai/core/work"
import { WorkGoalTable } from "@zaovra-ai/core/work/sql"
import { WorkWorker } from "@zaovra-ai/core/work/worker"
import { Duration, Effect } from "effect"
import { adjust } from "effect/testing/TestClock"
import { testEffect } from "./lib/effect"

const localID = Work.WorkerID.make("worker_local_test")
const it = testEffect(AppNodeBuilder.build(Database.node))

describe("WorkWorker", () => {
  it.effect("authenticates, polls, drains, and expires Worker heartbeats", () =>
    Effect.gen(function* () {
      const worker = yield* WorkWorker.Service
      const db = (yield* Database.Service).db
      expect(yield* worker.get(localID)).toMatchObject({
        id: localID,
        status: "online",
        credentialStatus: "local",
      })

      const enrollment = yield* worker.enroll({
        label: "Remote QA Worker",
        endpoint: "https://worker.example.test",
        capabilities: ["execute"],
        workspaceRoots: ["/project"],
        capacity: 2,
        executionMode: "remote",
        locationMappings: [{ controllerRoot: "C:\\project", workerRoot: "/project" }],
      })
      expect(enrollment).toMatchObject({
        worker: {
          status: "offline",
          credentialStatus: "enrolled",
          executionMode: "remote",
          capacity: 2,
          locationMappings: [{ controllerRoot: "C:\\project", workerRoot: "/project" }],
        },
      })
      expect(enrollment.token).toHaveLength(64)
      expect(yield* worker.authenticate(enrollment.worker.id, "wrong-token")).toBeFalse()
      expect(yield* worker.authenticate(enrollment.worker.id, enrollment.token)).toBeTrue()

      const firstRuntime = Work.WorkerRuntimeID.make("worker_runtime_first")
      const secondRuntime = Work.WorkerRuntimeID.make("worker_runtime_second")
      yield* worker.heartbeat({
        id: enrollment.worker.id,
        runtimeID: firstRuntime,
        label: enrollment.worker.label,
        endpoint: enrollment.worker.endpoint,
        capabilities: enrollment.worker.capabilities,
        workspaceRoots: enrollment.worker.workspaceRoots,
        capacity: 2,
      })
      expect(
        yield* worker.heartbeat({
          id: enrollment.worker.id,
          runtimeID: secondRuntime,
          label: "Fenced replacement",
          capabilities: ["execute"],
          workspaceRoots: ["/other"],
          capacity: 4,
        }),
      ).toMatchObject({ runtimeID: firstRuntime, label: enrollment.worker.label, capacity: 2 })
      yield* adjust(Duration.seconds(2))
      expect(
        yield* worker.heartbeat({
          id: enrollment.worker.id,
          runtimeID: secondRuntime,
          label: enrollment.worker.label,
          capabilities: enrollment.worker.capabilities,
          workspaceRoots: enrollment.worker.workspaceRoots,
          capacity: 2,
        }),
      ).toMatchObject({ runtimeID: secondRuntime, status: "online", capacity: 2 })
      expect(yield* worker.setDraining(enrollment.worker.id, true)).toMatchObject({ status: "draining" })
      expect(yield* worker.setDraining(enrollment.worker.id, false)).toMatchObject({ status: "online" })

      const goalID = Work.GoalID.make("goal_worker_poll")
      yield* db
        .insert(WorkGoalTable)
        .values({
          id: goalID,
          directory: AbsolutePath.make("/project"),
          objective: "Dispatch only to the assigned Worker",
          acceptance_criteria: [],
          worker_id: enrollment.worker.id,
          status: "active",
          usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
          revision: 2,
          time_created: 1,
          time_updated: 2,
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* worker.assignments(enrollment.worker.id)).toEqual([
        expect.objectContaining({ goalID, action: "wake", revision: 2 }),
      ])

      const rotated = (yield* worker.rotateCredential(enrollment.worker.id))!
      expect(rotated.worker).toMatchObject({ status: "offline", credentialStatus: "enrolled" })
      expect(yield* worker.authenticate(enrollment.worker.id, enrollment.token)).toBeFalse()
      expect(yield* worker.authenticate(enrollment.worker.id, rotated.token)).toBeTrue()

      yield* adjust(Duration.seconds(2))
      expect(yield* worker.get(enrollment.worker.id)).toMatchObject({ status: "offline" })
      expect(yield* worker.setDraining(enrollment.worker.id, false)).toMatchObject({ status: "offline" })

      expect(yield* worker.revokeCredential(enrollment.worker.id)).toMatchObject({ credentialStatus: "revoked" })
      expect(yield* worker.authenticate(enrollment.worker.id, rotated.token)).toBeFalse()
    }).pipe(
      Effect.provide(
        WorkWorker.makeLayer({
          local: {
            id: localID,
            label: "Local Worker",
            capabilities: ["execute", "worktree", "mcp"],
            workspaceRoots: ["*"],
          },
          durationMs: 1_000,
          automatic: false,
        }),
      ),
    ),
  )
})
