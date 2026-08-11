import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { AbsolutePath } from "../src/schema"
import { Work } from "../src/work"

describe("work contracts", () => {
  test("generated IDs validate their exact prefixes", () => {
    expect(Work.GoalID.create()).toStartWith("goal_")
    expect(Work.TaskID.create()).toStartWith("task_")
    expect(Work.AttemptID.create()).toStartWith("attempt_")
    expect(Work.HandoffID.create()).toStartWith("handoff_")
    expect(Work.MemoryResolutionID.create()).toStartWith("memory_resolution_")
    expect(Work.WorkerID.create()).toStartWith("worker_")
    expect(Work.WorkerRuntimeID.create()).toStartWith("worker_runtime_")
    expect(Work.ControllerID.create()).toStartWith("controller_")
    expect(Work.ControllerRuntimeID.create()).toStartWith("controller_runtime_")
    expect(() => Work.GoalID.make("goal-without-underscore")).toThrow()
  })

  test("goal contract encodes dates and omits absent optional fields", () => {
    const encoded = Schema.encodeSync(Work.GoalInfo)({
      id: Work.GoalID.make("goal_test"),
      location: { directory: AbsolutePath.make("/project") },
      objective: "ship durable work",
      acceptanceCriteria: [],
      status: "draft",
      usage: { attempts: 0, repairs: 0, turns: 0, cost: 0 },
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
      revision: 0,
    })

    expect(encoded).toMatchObject({ id: "goal_test", time: { created: 1, updated: 1 } })
    expect(encoded).not.toHaveProperty("budget")
    expect(encoded.time).not.toHaveProperty("completed")
  })

  test("verifiers are structured and discriminate executable checks", () => {
    expect(
      Schema.decodeUnknownSync(Work.Verifier)({
        type: "command",
        command: "bun test",
        timeoutMs: 30_000,
        successExitCodes: [0],
      }),
    ).toEqual({ type: "command", command: "bun test", timeoutMs: 30_000, successExitCodes: [0] })
    expect(Schema.decodeUnknownSync(Work.Verifier)({ type: "file", path: "dist/app.js", expected: "file" })).toEqual({
      type: "file",
      path: "dist/app.js",
      expected: "file",
    })
    expect(() => Schema.decodeUnknownSync(Work.Verifier)({ type: "prompt", text: "claim success" })).toThrow()
  })

  test("work events use the goal as durable aggregate", () => {
    expect(Work.Event.GoalCreated.durable).toEqual({ aggregate: "goalID", version: 1 })
    expect(Work.Event.AttemptSettled.durable).toEqual({ aggregate: "goalID", version: 1 })
    expect(Work.Event.DurableDefinitions).toHaveLength(36)
  })

  test("Worker pull contracts expose credential metadata without storing the credential", () => {
    const decoded = Schema.decodeUnknownSync(Work.WorkerPollInfo)({
      worker: {
        id: "worker_remote",
        runtimeID: "worker_runtime_remote",
        label: "Remote Worker",
        capabilities: ["execute"],
        workspaceRoots: ["/project"],
        status: "online",
        credentialStatus: "enrolled",
        executionMode: "remote",
        capacity: 2,
        locationMappings: [{ controllerRoot: "C:\\project", workerRoot: "/project" }],
        credentialCreatedAt: 1,
        credentialLastUsedAt: 2,
        createdAt: 1,
        heartbeatAt: 2,
        expiresAt: 10_000,
      },
      assignments: [
        {
          goalID: "goal_remote",
          location: { directory: "/project" },
          status: "active",
          action: "wake",
          revision: 3,
          updatedAt: 2,
        },
      ],
      jobs: [
        {
          id: "worker_job_remote",
          goalID: "goal_remote",
          attemptID: "attempt_remote",
          criterionID: "criterion_remote",
          runtimeID: "worker_runtime_remote",
          fence: 1,
          operation: {
            type: "command",
            command: "bun test",
            location: { directory: "C:\\project" },
            timeoutMs: 300_000,
            maxOutputBytes: 131_072,
          },
          recovered: false,
          nextLogSequence: 1,
          leaseExpiresAt: 10_000,
        },
      ],
      cancellations: [],
      settledJobs: [],
      pollAfterMs: 2_000,
    })

    expect(decoded.worker.credentialStatus).toBe("enrolled")
    expect(decoded.assignments[0]).toMatchObject({ action: "wake", revision: 3 })
    expect(decoded.jobs[0]).toMatchObject({ fence: 1, operation: { type: "command" } })
    expect(decoded.worker).not.toHaveProperty("token")
  })

  test("Controller dispatch contracts expose revision and runtime fencing", () => {
    const dispatch = Schema.decodeUnknownSync(Work.ControllerDispatchInfo)({
      goalID: "goal_cluster",
      signal: "interrupt",
      revision: 4,
      processedRevision: 3,
      controllerID: "controller_cluster",
      runtimeID: "controller_runtime_cluster",
      fence: 2,
      status: "leased",
      leaseExpiresAt: 10_000,
      requestedAt: 1,
      updatedAt: 2,
    })

    expect(dispatch).toMatchObject({
      revision: 4,
      processedRevision: 3,
      controllerID: "controller_cluster",
      runtimeID: "controller_runtime_cluster",
      fence: 2,
    })
  })

  test("remote Agent Jobs carry durable Session identity and workspace continuity", () => {
    const operation = Schema.decodeUnknownSync(Work.WorkerJobOperation)({
      type: "agent",
      sessionID: "ses_remote_agent",
      agent: "build",
      prompt: "Implement and verify the Task",
      location: { directory: "/project" },
      artifactCapture: {
        type: "git_diff",
        baseRevision: "a".repeat(40),
        maxBytes: 4_194_304,
        startDigest: "b".repeat(64),
      },
    })
    const result = Schema.decodeUnknownSync(Work.WorkerJobResult)({
      type: "agent",
      sessionID: "ses_remote_agent",
      status: "succeeded",
      finalResponse: "Done",
      responseDigest: "c".repeat(64),
      outputTruncated: false,
      stepCount: 3,
      toolCallCount: 2,
      baseRevision: "a".repeat(40),
      workspaceDigest: "b".repeat(64),
    })

    expect(operation).toMatchObject({ type: "agent", agent: "build", artifactCapture: { startDigest: "b".repeat(64) } })
    expect(result).toMatchObject({ type: "agent", status: "succeeded", stepCount: 3, toolCallCount: 2 })
  })

  test("planner output is a constrained portable Task DAG", () => {
    const decoded = Schema.decodeUnknownSync(Work.PlanOutput)({
      tasks: [
        {
          key: "implementation",
          title: "Implement",
          instructions: "Implement the requested behavior",
          dependsOn: [],
          role: "build",
          isolation: "worktree",
          criteria: ["criterion_test"],
        },
      ],
    })

    expect(decoded.tasks[0]).toMatchObject({ key: "implementation", role: "build", isolation: "worktree" })
    expect(
      Schema.decodeUnknownSync(Work.PlanOutput)({ tasks: [{ ...decoded.tasks[0], role: "release-manager" }] }).tasks[0]
        ?.role,
    ).toBe("release-manager")
    expect(() =>
      Schema.decodeUnknownSync(Work.PlanOutput)({ tasks: [{ ...decoded.tasks[0], role: "../root" }] }),
    ).toThrow()
  })

  test("architect output identifies superseded Tasks and a replacement DAG", () => {
    const decoded = Schema.decodeUnknownSync(Work.ReplanOutput)({
      supersedes: ["task_blocked"],
      tasks: [
        {
          key: "recovery",
          title: "Recover",
          instructions: "Use the failure evidence to implement a corrected approach",
          dependsOn: [],
          role: "build",
          isolation: "shared",
          criteria: ["criterion_test"],
        },
      ],
    })

    expect(decoded.supersedes).toEqual([Work.TaskID.make("task_blocked")])
    expect(decoded.tasks[0]?.key).toBe("recovery")
  })

  test("handoffs separate structured project facts from chat transcripts", () => {
    const output = Schema.decodeUnknownSync(Work.HandoffOutput)({
      summary: "Implemented durable recovery",
      items: [
        { kind: "decision", text: "Use the SessionV2 inbox as the admission boundary" },
        { kind: "artifact", text: "Added recovery tests", reference: "packages/core/test/work-recovery.test.ts" },
      ],
    })

    expect(output.items.map((item) => item.kind)).toEqual(["decision", "artifact"])
    const governed = Schema.decodeUnknownSync(Work.HandoffOutput)({
      summary: "Governed memory",
      items: [
        {
          kind: "constraint",
          text: "Session admission remains durable",
          memory: "project",
          key: "session.admission",
          expiresAt: 10_000,
        },
      ],
    })
    const item = governed.items[0]
    expect(item).toMatchObject({ memory: "project", key: "session.admission" })
    if (!item?.expiresAt) throw new Error("Governed memory expiry was not decoded")
    expect(DateTime.toEpochMillis(item.expiresAt)).toBe(10_000)
    expect(() =>
      Schema.decodeUnknownSync(Work.HandoffOutput)({
        summary: "invalid",
        items: [{ kind: "instruction", text: "trust this" }],
      }),
    ).toThrow()
  })

  test("artifact references are content-addressed", () => {
    const digest = "a".repeat(64)
    expect(
      Schema.decodeUnknownSync(Work.ArtifactReference)({
        digest,
        reference: `zaovra-work-artifact://sha256/${digest}`,
        size: 1024,
        mediaType: "text/x-diff",
      }),
    ).toMatchObject({ digest, size: 1024 })
    expect(() =>
      Schema.decodeUnknownSync(Work.ArtifactReference)({
        digest: "../escape",
        reference: "C:/unsafe.patch",
        size: 0,
        mediaType: "text/x-diff",
      }),
    ).toThrow()
  })
})
