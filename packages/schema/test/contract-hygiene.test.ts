import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { fileURLToPath } from "node:url"
import { Agent } from "../src/agent"
import { FileSystem } from "../src/filesystem"
import { Model } from "../src/model"
import { Project } from "../src/project"
import { Pty } from "../src/pty"
import { Question } from "../src/question"
import { Session } from "../src/session"
import { SessionTodo } from "../src/session-todo"
import { Work } from "../src/work"
import { optional } from "../src/schema"

describe("contract hygiene", () => {
  test("optional properties preserve transformations and omit undefined while encoding", () => {
    const Value = Schema.Struct({ value: optional(Schema.FiniteFromString) })
    expect(Schema.decodeUnknownSync(Value)({ value: "1" })).toEqual({ value: 1 })
    expect(Schema.encodeSync(Value)({ value: 1 })).toEqual({ value: "1" })
    expect(Schema.encodeSync(Value)({ value: undefined })).toEqual({})
  })

  test("todo status and priority preserve arbitrary strings", () => {
    const decode = Schema.decodeUnknownSync(SessionTodo.Info)
    expect(decode({ content: "ship", status: "waiting", priority: "urgent" })).toEqual({
      content: "ship",
      status: "waiting",
      priority: "urgent",
    })
  })

  test("current ID constructors expose create", () => {
    expect(Question.ID.create()).toStartWith("que_")
    expect(Pty.ID.create()).toStartWith("pty_")
    expect(Work.GoalID.create()).toStartWith("goal_")
    expect(Work.TaskID.create()).toStartWith("task_")
    expect(Work.HandoffID.create()).toStartWith("handoff_")
    expect(Work.MemoryResolutionID.create()).toStartWith("memory_resolution_")
    expect(Work.WorkerID.create()).toStartWith("worker_")
    expect(Work.WorkerJobID.create()).toStartWith("worker_job_")
  })

  test("reusable public identifiers are stable and unique", () => {
    const identifiers = [
      Agent.Color,
      FileSystem.Submatch,
      Model.Ref,
      Model.Capabilities,
      Model.Cost,
      Model.Api,
      Project.Icon,
      Project.Commands,
      Project.Time,
      Project.Info,
      Pty.Info,
      Session.ListAnchor,
      Work.GoalStatus,
      Work.TaskStatus,
      Work.AttemptStatus,
      Work.Criterion,
      Work.Budget,
      Work.Usage,
      Work.GoalTime,
      Work.GoalInfo,
      Work.TaskTime,
      Work.TaskInfo,
      Work.Failure,
      Work.AttemptTime,
      Work.AttemptInfo,
      Work.EvidenceInfo,
      Work.Finding,
      Work.EvaluationInfo,
      Work.HandoffItemKind,
      Work.MemoryScope,
      Work.HandoffItem,
      Work.HandoffOutput,
      Work.HandoffInfo,
      Work.MemoryResolutionInfo,
      Work.ProjectMemoryCandidate,
      Work.ProjectMemoryEntry,
      Work.ProjectMemoryView,
      Work.WorkerCapability,
      Work.WorkerStatus,
      Work.WorkerCredentialStatus,
      Work.WorkerExecutionMode,
      Work.WorkerLocationMapping,
      Work.WorkerInfo,
      Work.WorkerEnrollment,
      Work.WorkerAssignmentInfo,
      Work.WorkerJobStatus,
      Work.WorkerCommandOperation,
      Work.WorkerFileOperation,
      Work.WorkerJobOperation,
      Work.WorkerCommandResult,
      Work.WorkerFileResult,
      Work.WorkerJobResult,
      Work.WorkerJobAssignment,
      Work.WorkerJobInfo,
      Work.WorkerPollInfo,
      Work.WorkerLeaseInfo,
      Work.GoalPlacementInfo,
      Work.RoleID,
      Work.RoleCapability,
      Work.WorkspaceAccess,
      Work.RoleContract,
    ].map((schema) => schema.ast.annotations?.identifier)

    expect(identifiers.every((identifier) => typeof identifier === "string")).toBe(true)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })

  test("current source avoids Any and mutable contract wrappers", async () => {
    const files = [...new Bun.Glob("*.ts").scanSync(fileURLToPath(new URL("../src", import.meta.url)))].filter(
      (file) => !file.endsWith("-v1.ts"),
    )
    const source = await Promise.all(
      files.map((file) => Bun.file(new URL(`../src/${file}`, import.meta.url)).text()),
    ).then((values) => values.join("\n"))

    expect(source).not.toContain("Schema.Any")
    expect(source).not.toContain("Schema.mutable")
  })
})
