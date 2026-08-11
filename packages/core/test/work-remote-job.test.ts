import { describe, expect } from "bun:test"
import { Database } from "@zaovra-ai/core/database/database"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { Work } from "@zaovra-ai/core/work"
import { WorkRemoteJob } from "@zaovra-ai/core/work/remote-job"
import { WorkAttemptTable, WorkGoalTable, WorkTaskTable, WorkWorkerTable } from "@zaovra-ai/core/work/sql"
import { Duration, Effect, Fiber } from "effect"
import { adjust } from "effect/testing/TestClock"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, WorkRemoteJob.node])))
const workerID = Work.WorkerID.make("worker_remote_job")
const runtimeID = Work.WorkerRuntimeID.make("worker_runtime_remote_job")
const goalID = Work.GoalID.make("goal_remote_job")
const taskID = Work.TaskID.make("task_remote_job")

describe("WorkRemoteJob", () => {
  it.effect("dispatches, renews, completes, and fences a remote execution result", () =>
    Effect.gen(function* () {
      yield* setup()
      const jobs = yield* WorkRemoteJob.Service
      const attemptID = Work.AttemptID.make("attempt_remote_job")
      const criterionID = Work.CriterionID.make("criterion_remote_job")
      yield* insertAttempt(attemptID)
      const baseRevision = "a".repeat(40)
      const operation = Work.WorkerCommandOperation.make({
        type: "command",
        command: "bun test",
        location: { directory: AbsolutePath.make("C:\\project") },
        timeoutMs: 30_000,
        maxOutputBytes: 4_096,
        artifactCapture: { type: "git_diff", baseRevision, maxBytes: 1024 * 1024 },
      })
      const resultFiber = yield* jobs
        .dispatch({ workerID, goalID, attemptID, criterionID, operation })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow

      const assignment = (yield* jobs.claim({ workerID, runtimeID, capacity: 1, recoverableJobIDs: [] })).jobs[0]
      expect(assignment).toMatchObject({ goalID, attemptID, criterionID, fence: 1 })
      expect(
        yield* jobs.renew({
          workerID,
          runtimeID: Work.WorkerRuntimeID.make("worker_runtime_stale"),
          jobID: assignment.id,
          fence: assignment.fence,
        }),
      ).toBeFalse()
      expect(yield* jobs.renew({ workerID, jobID: assignment.id, fence: 2 })).toBeFalse()
      expect(yield* jobs.renew({ workerID, jobID: assignment.id, fence: assignment.fence })).toBeTrue()
      expect(
        yield* jobs.appendLog({
          workerID,
          jobID: assignment.id,
          fence: assignment.fence,
          sequence: 2,
          stream: "system",
          message: "out of order",
        }),
      ).toBeFalse()
      expect(
        yield* jobs.appendLog({
          workerID,
          jobID: assignment.id,
          fence: assignment.fence,
          sequence: 1,
          stream: "system",
          message: "started",
        }),
      ).toBeTrue()
      expect(
        yield* jobs.appendLog({
          workerID,
          jobID: assignment.id,
          fence: assignment.fence,
          sequence: 1,
          stream: "system",
          message: "started",
        }),
      ).toBeTrue()
      expect(
        yield* jobs.appendLog({
          workerID,
          jobID: assignment.id,
          fence: assignment.fence,
          sequence: 1,
          stream: "error",
          message: "conflicting retry",
        }),
      ).toBeFalse()
      const content = "diff --git a/file.txt b/file.txt\n"
      const digest = Work.ArtifactDigest.make(new Bun.CryptoHasher("sha256").update(content).digest("hex"))
      expect(
        yield* jobs.uploadArtifact({
          workerID,
          jobID: assignment.id,
          fence: assignment.fence,
          label: "workspace.patch",
          digest: Work.ArtifactDigest.make("0".repeat(64)),
          size: Buffer.byteLength(content),
          content,
        }),
      ).toBeUndefined()
      const artifact = yield* jobs.uploadArtifact({
        workerID,
        jobID: assignment.id,
        fence: assignment.fence,
        label: "workspace.patch",
        digest,
        size: Buffer.byteLength(content),
        content,
      })
      expect(artifact).toMatchObject({ digest, size: Buffer.byteLength(content), mediaType: "text/x-diff" })
      expect(
        yield* jobs.uploadArtifact({
          workerID,
          jobID: assignment.id,
          fence: assignment.fence,
          label: "workspace.patch",
          digest,
          size: Buffer.byteLength(content),
          content,
        }),
      ).toEqual(artifact)
      expect(
        yield* jobs.complete({
          workerID,
          jobID: assignment.id,
          fence: 2,
          result: Work.WorkerCommandResult.make({
            type: "command",
            exitCode: 0,
            output: "stale",
            outputTruncated: false,
          }),
        }),
      ).toBeFalse()
      expect(
        yield* jobs.complete({
          workerID,
          jobID: assignment.id,
          fence: assignment.fence,
          result: Work.WorkerCommandResult.make({
            type: "command",
            exitCode: 0,
            output: "71 pass",
            outputTruncated: false,
            baseRevision,
            artifacts: [artifact!],
          }),
        }),
      ).toBeTrue()
      expect(
        yield* jobs.complete({
          workerID,
          jobID: assignment.id,
          fence: assignment.fence,
          result: Work.WorkerCommandResult.make({
            type: "command",
            exitCode: 0,
            output: "71 pass",
            outputTruncated: false,
            baseRevision,
            artifacts: [artifact!],
          }),
        }),
      ).toBeTrue()
      expect(
        yield* jobs.complete({
          workerID,
          jobID: assignment.id,
          fence: assignment.fence,
          result: Work.WorkerCommandResult.make({
            type: "command",
            exitCode: 1,
            output: "conflicting retry",
            outputTruncated: false,
            baseRevision,
            artifacts: [artifact!],
          }),
        }),
      ).toBeFalse()
      yield* adjust(Duration.millis(250))
      expect(yield* Fiber.join(resultFiber)).toMatchObject({ type: "command", exitCode: 0, output: "71 pass" })
      expect(yield* jobs.logs(assignment.id)).toMatchObject([{ sequence: 1, stream: "system", message: "started" }])
      expect(yield* jobs.get(assignment.id)).toMatchObject({
        status: "completed",
        logCount: 1,
        artifacts: [{ label: "workspace.patch" }],
      })
      expect(yield* jobs.list(goalID)).toHaveLength(1)
      expect(yield* jobs.artifact(assignment.id, digest)).toMatchObject({ content, artifact: { artifact } })
      expect(yield* jobs.dispatch({ workerID, goalID, attemptID, criterionID, operation })).toMatchObject({
        exitCode: 0,
      })
    }),
  )

  it.effect("marks an expired leased Job unknown instead of silently replaying it", () =>
    Effect.gen(function* () {
      yield* setup()
      const jobs = yield* WorkRemoteJob.Service
      const attemptID = Work.AttemptID.make("attempt_remote_job_unknown")
      const criterionID = Work.CriterionID.make("criterion_remote_job_unknown")
      yield* insertAttempt(attemptID)
      const operation = Work.WorkerCommandOperation.make({
        type: "command",
        command: "dangerous-command",
        location: { directory: AbsolutePath.make("C:\\project") },
        timeoutMs: 30_000,
        maxOutputBytes: 4_096,
      })
      const resultFiber = yield* jobs
        .dispatch({ workerID, goalID, attemptID, criterionID, operation })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const assignment = (yield* jobs.claim({ workerID, runtimeID, capacity: 1, recoverableJobIDs: [] })).jobs[0]
      yield* adjust(Duration.seconds(16))
      yield* Effect.yieldNow
      yield* adjust(Duration.seconds(31))
      expect(yield* Fiber.join(resultFiber)).toMatchObject({
        type: "command",
        error: expect.stringContaining("unknown outcome"),
      })
      expect(yield* jobs.get(assignment.id)).toMatchObject({ status: "unknown", fence: 1 })
    }),
  )

  it.effect("fences remote Agent transcripts and their cumulative workspace artifact", () =>
    Effect.gen(function* () {
      yield* setup()
      const jobs = yield* WorkRemoteJob.Service
      const attemptID = Work.AttemptID.make("attempt_remote_agent")
      const criterionID = WorkRemoteJob.agentCriterionID(attemptID)
      yield* insertAttempt(attemptID)
      const baseRevision = "d".repeat(40)
      const operation = Work.WorkerAgentOperation.make({
        type: "agent",
        sessionID: SessionV2.ID.make("ses_remote_agent"),
        agent: AgentV2.ID.make("build"),
        prompt: "Implement the Task",
        location: { directory: AbsolutePath.make("C:\\project") },
        artifactCapture: { type: "git_diff", baseRevision, maxBytes: 1024 * 1024 },
      })
      const resultFiber = yield* jobs
        .dispatch({ workerID, goalID, attemptID, criterionID, operation })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const assignment = (yield* jobs.claim({ workerID, runtimeID, capacity: 1, recoverableJobIDs: [] })).jobs[0]
      const content = "diff --git a/agent.txt b/agent.txt\n"
      const digest = Work.ArtifactDigest.make(new Bun.CryptoHasher("sha256").update(content).digest("hex"))
      const artifact = yield* jobs.uploadArtifact({
        workerID,
        jobID: assignment.id,
        fence: assignment.fence,
        label: "workspace.patch",
        digest,
        size: Buffer.byteLength(content),
        content,
      })
      expect(
        yield* jobs.complete({
          workerID,
          jobID: assignment.id,
          fence: assignment.fence,
          result: Work.WorkerAgentResult.make({
            type: "agent",
            sessionID: operation.sessionID,
            status: "succeeded",
            finalResponse: "Done",
            responseDigest: Work.ArtifactDigest.make("0".repeat(64)),
            outputTruncated: false,
            stepCount: 2,
            toolCallCount: 1,
            baseRevision,
            workspaceDigest: digest,
            artifacts: [artifact!],
          }),
        }),
      ).toBeFalse()
      const responseDigest = Work.ArtifactDigest.make(new Bun.CryptoHasher("sha256").update("Done").digest("hex"))
      expect(
        yield* jobs.complete({
          workerID,
          jobID: assignment.id,
          fence: assignment.fence,
          result: Work.WorkerAgentResult.make({
            type: "agent",
            sessionID: operation.sessionID,
            status: "succeeded",
            finalResponse: "Done",
            responseDigest,
            outputTruncated: false,
            stepCount: 2,
            toolCallCount: 1,
            baseRevision,
            workspaceDigest: digest,
            artifacts: [artifact!],
          }),
        }),
      ).toBeTrue()
      yield* adjust(Duration.millis(250))
      expect(yield* Fiber.join(resultFiber)).toMatchObject({
        type: "agent",
        status: "succeeded",
        responseDigest,
        workspaceDigest: digest,
      })
    }),
  )

  it.effect("claims only available Worker slots and keeps excess Jobs queued", () =>
    Effect.gen(function* () {
      yield* setup()
      const jobs = yield* WorkRemoteJob.Service
      const attemptID = Work.AttemptID.make("attempt_remote_capacity")
      yield* insertAttempt(attemptID)
      const fibers = yield* Effect.forEach(
        ["a", "b", "c"],
        (suffix) =>
          jobs
            .dispatch({
              workerID,
              goalID,
              attemptID,
              criterionID: Work.CriterionID.make(`criterion_remote_capacity_${suffix}`),
              operation: commandOperation(`job-${suffix}`),
            })
            .pipe(Effect.forkChild),
        { concurrency: 1 },
      )
      yield* Effect.yieldNow

      const first = yield* jobs.claim({ workerID, runtimeID, capacity: 2, recoverableJobIDs: [] })
      expect(first.jobs).toHaveLength(2)
      expect((yield* jobs.claim({ workerID, runtimeID, capacity: 2, recoverableJobIDs: [] })).jobs).toHaveLength(0)
      expect(
        yield* jobs.complete({
          workerID,
          runtimeID,
          jobID: first.jobs[0].id,
          fence: first.jobs[0].fence,
          result: Work.WorkerCommandResult.make({ type: "command", exitCode: 0, outputTruncated: false }),
        }),
      ).toBeTrue()
      expect((yield* jobs.claim({ workerID, runtimeID, capacity: 2, recoverableJobIDs: [] })).jobs).toHaveLength(1)
      yield* Effect.forEach(fibers, Fiber.interrupt, { concurrency: "unbounded", discard: true })
    }),
  )

  it.effect("delivers cancellation to the owning runtime and accepts only an interrupted acknowledgement", () =>
    Effect.gen(function* () {
      yield* setup()
      const jobs = yield* WorkRemoteJob.Service
      const attemptID = Work.AttemptID.make("attempt_remote_cancel")
      yield* insertAttempt(attemptID)
      const fiber = yield* jobs
        .dispatch({
          workerID,
          goalID,
          attemptID,
          criterionID: Work.CriterionID.make("criterion_remote_cancel"),
          operation: commandOperation("cancel-me"),
        })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const assignment = (yield* jobs.claim({ workerID, runtimeID, capacity: 1, recoverableJobIDs: [] })).jobs[0]
      expect(yield* jobs.requestCancel(assignment.id, "Goal was cancelled")).toBeTrue()
      const cancelling = yield* jobs.claim({ workerID, runtimeID, capacity: 1, recoverableJobIDs: [] })
      expect(cancelling.cancellations).toMatchObject([{ id: assignment.id, fence: assignment.fence }])
      expect(
        yield* jobs.complete({
          workerID,
          runtimeID,
          jobID: assignment.id,
          fence: assignment.fence,
          result: Work.WorkerCommandResult.make({ type: "command", exitCode: 0, outputTruncated: false }),
        }),
      ).toBeFalse()
      const interrupted = Work.WorkerCommandResult.make({
        type: "command",
        interrupted: true,
        error: "Interrupted by cancellation",
        outputTruncated: false,
      })
      expect(
        yield* jobs.complete({
          workerID,
          runtimeID,
          jobID: assignment.id,
          fence: assignment.fence,
          result: interrupted,
        }),
      ).toBeTrue()
      yield* adjust(Duration.millis(250))
      expect(yield* Fiber.join(fiber)).toEqual(interrupted)
      expect(yield* jobs.get(assignment.id)).toMatchObject({
        status: "completed",
        cancelReason: "Goal was cancelled",
      })
    }),
  )

  it.effect("rebinds only a durably recoverable result after the old runtime lease expires", () =>
    Effect.gen(function* () {
      yield* setup()
      const jobs = yield* WorkRemoteJob.Service
      const attemptID = Work.AttemptID.make("attempt_remote_recovery")
      yield* insertAttempt(attemptID)
      const fiber = yield* jobs
        .dispatch({
          workerID,
          goalID,
          attemptID,
          criterionID: Work.CriterionID.make("criterion_remote_recovery"),
          operation: commandOperation("recover-result"),
        })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const original = (yield* jobs.claim({ workerID, runtimeID, capacity: 1, recoverableJobIDs: [] })).jobs[0]
      yield* adjust(Duration.seconds(16))
      const recoveredRuntime = Work.WorkerRuntimeID.make("worker_runtime_recovered")
      yield* (yield* Database.Service).db
        .update(WorkWorkerTable)
        .set({ runtime_id: recoveredRuntime })
        .where(eq(WorkWorkerTable.id, workerID))
        .run()
        .pipe(Effect.orDie)
      const recovered = (yield* jobs.claim({
        workerID,
        runtimeID: recoveredRuntime,
        capacity: 1,
        recoverableJobIDs: [original.id],
      })).jobs[0]
      expect(recovered).toMatchObject({ id: original.id, fence: 2, recovered: true, runtimeID: recoveredRuntime })
      const result = Work.WorkerCommandResult.make({ type: "command", exitCode: 0, outputTruncated: false })
      expect(
        yield* jobs.complete({
          workerID,
          runtimeID: recoveredRuntime,
          jobID: recovered.id,
          fence: recovered.fence,
          result,
        }),
      ).toBeTrue()
      yield* adjust(Duration.millis(250))
      expect(yield* Fiber.join(fiber)).toEqual(result)
    }),
  )

  it.effect("turns interruption of the controller waiter into a durable remote cancellation request", () =>
    Effect.gen(function* () {
      yield* setup()
      const jobs = yield* WorkRemoteJob.Service
      const attemptID = Work.AttemptID.make("attempt_remote_waiter_cancel")
      yield* insertAttempt(attemptID)
      const fiber = yield* jobs
        .dispatch({
          workerID,
          goalID,
          attemptID,
          criterionID: Work.CriterionID.make("criterion_remote_waiter_cancel"),
          operation: commandOperation("waiter-cancel"),
        })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const assignment = (yield* jobs.claim({ workerID, runtimeID, capacity: 1, recoverableJobIDs: [] })).jobs[0]
      yield* Fiber.interrupt(fiber)
      expect(yield* jobs.get(assignment.id)).toMatchObject({ status: "cancelling" })
      expect(
        (yield* jobs.claim({ workerID, runtimeID, capacity: 1, recoverableJobIDs: [] })).cancellations,
      ).toMatchObject([{ id: assignment.id, runtimeID, fence: assignment.fence }])
    }),
  )
})

function commandOperation(command: string) {
  return Work.WorkerCommandOperation.make({
    type: "command",
    command,
    location: { directory: AbsolutePath.make("C:\\project") },
    timeoutMs: 30_000,
    maxOutputBytes: 4_096,
  })
}

function setup() {
  return Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(WorkWorkerTable)
      .values({
        id: workerID,
        runtime_id: runtimeID,
        capacity: 1,
        label: "Remote Worker",
        capabilities: ["execute"],
        workspace_roots: ["/project"],
        execution_mode: "remote",
        location_mappings: [{ controllerRoot: "C:\\project", workerRoot: "/project" }],
        time_created: 0,
        time_heartbeat: 0,
        expires_at: 60_000,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkGoalTable)
      .values({
        id: goalID,
        directory: AbsolutePath.make("C:\\project"),
        objective: "Run verification remotely",
        acceptance_criteria: [],
        worker_id: workerID,
        status: "active",
        usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
        revision: 0,
        time_created: 0,
        time_updated: 0,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(WorkTaskTable)
      .values({
        id: taskID,
        goal_id: goalID,
        title: "Remote verifier",
        instructions: "Run the verifier",
        depends_on: [],
        role: "qa",
        status: "verifying",
        criteria: [],
        attempt_count: 1,
        revision: 0,
        time_created: 0,
        time_updated: 0,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })
}

function insertAttempt(attemptID: Work.AttemptID) {
  return Database.Service.use((database) =>
    database.db
      .insert(WorkAttemptTable)
      .values({
        id: attemptID,
        goal_id: goalID,
        task_id: taskID,
        kind: "verify",
        number: attemptID.endsWith("unknown") ? 2 : 1,
        status: "running",
        input_revision: 0,
        time_created: 0,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )
}
