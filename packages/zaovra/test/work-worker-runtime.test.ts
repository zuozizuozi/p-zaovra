import { describe, expect, test } from "bun:test"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@zaovra-ai/core/effect/app-node"
import { AppProcess } from "@zaovra-ai/core/process"
import { Database } from "@zaovra-ai/core/database/database"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { Work } from "@zaovra-ai/core/work"
import { DateTime, Effect } from "effect"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "path"
import {
  executeOperation,
  isSecureController,
  mapDirectory,
  outboxReady,
  prepareOutbox,
  removeOutbox,
  saveOutbox,
} from "../src/worker/runtime"

describe("WorkWorkerRuntime", () => {
  test("maps controller Locations with the longest root and preserves relative path casing", () => {
    expect(
      mapDirectory("C:\\Project\\Src\\Feature.ts", [
        { controllerRoot: "C:\\Project", workerRoot: "D:\\Worker\\Project" },
        { controllerRoot: "C:\\Project\\Src", workerRoot: "D:\\Worker\\Source" },
      ]),
    ).toBe(path.resolve("D:\\Worker\\Source", "Feature.ts"))
    expect(
      mapDirectory("/Controller/Project/Src", [
        { controllerRoot: "/controller/project", workerRoot: "D:\\Worker\\Project" },
      ]),
    ).toBeUndefined()
    expect(
      mapDirectory("C:\\Project\\..\\Outside", [{ controllerRoot: "C:\\Project", workerRoot: "D:\\Worker\\Project" }]),
    ).toBeUndefined()
  })

  test("requires HTTPS except for loopback development controllers", () => {
    expect(isSecureController("https://controller.example.test")).toBeTrue()
    expect(isSecureController("http://127.0.0.1:4096")).toBeTrue()
    expect(isSecureController("http://localhost:4096")).toBeTrue()
    expect(isSecureController("http://192.168.1.10:4096")).toBeFalse()
    expect(isSecureController("not-a-url")).toBeFalse()
  })

  test("captures a clean revision as an unstaged content-addressable patch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zaovra-worker-capture-"))
    const project = path.join(root, "project")
    await mkdir(project)
    await git(project, ["init"])
    await git(project, ["config", "user.email", "worker@example.test"])
    await git(project, ["config", "user.name", "ZAOVRA Worker"])
    await writeFile(path.join(project, "file.txt"), "initial\n")
    await git(project, ["add", "file.txt"])
    await git(project, ["commit", "-m", "initial"])
    const revision = (await git(project, ["rev-parse", "HEAD"])).trim()
    const now = DateTime.makeUnsafe(0)
    const worker = Work.WorkerInfo.make({
      id: Work.WorkerID.make("worker_capture_test"),
      label: "Capture Worker",
      capabilities: ["execute"],
      workspaceRoots: [project],
      status: "online",
      credentialStatus: "enrolled",
      executionMode: "remote",
      capacity: 1,
      locationMappings: [{ controllerRoot: "C:\\Controller\\Project", workerRoot: project }],
      createdAt: now,
      heartbeatAt: now,
      expiresAt: DateTime.makeUnsafe(60_000),
    })
    const observed: string[] = []
    const output = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* executeOperation(
          yield* AppProcess.Service,
          worker,
          Work.WorkerCommandOperation.make({
            type: "command",
            command: "echo live-output && echo changed>file.txt",
            location: { directory: AbsolutePath.make("C:\\Controller\\Project") },
            timeoutMs: 30_000,
            maxOutputBytes: 4_096,
            artifactCapture: { type: "git_diff", baseRevision: revision, maxBytes: 1024 * 1024 },
          }),
          (message) => Effect.sync(() => observed.push(message)),
        )
      }).pipe(Effect.provide(AppNodeBuilder.build(AppProcess.node))),
    )
    expect(output.result).toMatchObject({ type: "command", exitCode: 0, baseRevision: revision })
    expect(output.artifacts).toHaveLength(1)
    expect(observed.join("")).toContain("live-output")
    expect(output.artifacts[0]?.content).toContain("diff --git a/file.txt b/file.txt")
    expect(await gitCode(project, ["diff", "--cached", "--quiet"])).toBe(0)
    const startDigest = new Bun.CryptoHasher("sha256").update(output.artifacts[0].content).digest("hex")
    const repair = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* executeOperation(
          yield* AppProcess.Service,
          worker,
          Work.WorkerCommandOperation.make({
            type: "command",
            command: "echo repaired>file.txt",
            location: { directory: AbsolutePath.make("C:\\Controller\\Project") },
            timeoutMs: 30_000,
            maxOutputBytes: 4_096,
            artifactCapture: {
              type: "git_diff",
              baseRevision: revision,
              maxBytes: 1024 * 1024,
              startDigest: Work.ArtifactDigest.make(startDigest),
            },
          }),
        )
      }).pipe(Effect.provide(AppNodeBuilder.build(AppProcess.node))),
    )
    expect(repair.result).toMatchObject({ type: "command", exitCode: 0 })
    expect(repair.artifacts[0]?.content).toContain("repaired")
    const rejected = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* executeOperation(
          yield* AppProcess.Service,
          worker,
          Work.WorkerCommandOperation.make({
            type: "command",
            command: "echo must-not-run",
            location: { directory: AbsolutePath.make("C:\\Controller\\Project") },
            timeoutMs: 30_000,
            maxOutputBytes: 4_096,
            artifactCapture: {
              type: "git_diff",
              baseRevision: revision,
              maxBytes: 1024 * 1024,
              startDigest: Work.ArtifactDigest.make("0".repeat(64)),
            },
          }),
        )
      }).pipe(Effect.provide(AppNodeBuilder.build(AppProcess.node))),
    )
    expect(rejected.result).toMatchObject({
      type: "command",
      error: expect.stringContaining("does not match required starting digest"),
    })
    await rm(root, { recursive: true, force: true })
  })

  test("recovers only a result that reached the durable local outbox boundary", async () => {
    const database = makeGlobalNode({
      service: Database.Service,
      layer: Database.layerFromPath(":memory:"),
      deps: [],
    })
    const workerID = Work.WorkerID.make("worker_outbox_test")
    const operation = Work.WorkerCommandOperation.make({
      type: "command",
      command: "durable-result",
      location: { directory: AbsolutePath.make("C:\\Controller\\Project") },
      timeoutMs: 30_000,
      maxOutputBytes: 4_096,
    })
    const makeInput = (runtimeID: Work.WorkerRuntimeID) => ({
      controller: "http://127.0.0.1:4096",
      workerID,
      runtimeID,
      token: "token",
      mode: "remote" as const,
      username: "zaovra",
      label: "Outbox Worker",
      capabilities: ["execute"] as const,
      workspaceRoots: [os.tmpdir()],
      capacity: 1,
    })
    const makeJob = (runtimeID: Work.WorkerRuntimeID, fence: number, recovered: boolean) =>
      Work.WorkerJobAssignment.make({
        id: Work.WorkerJobID.make("worker_job_outbox_test"),
        goalID: Work.GoalID.make("goal_outbox_test"),
        attemptID: Work.AttemptID.make("attempt_outbox_test"),
        criterionID: Work.CriterionID.make("criterion_outbox_test"),
        runtimeID,
        fence,
        operation,
        recovered,
        nextLogSequence: 1,
        leaseExpiresAt: DateTime.makeUnsafe(60_000),
      })
    const firstRuntime = Work.WorkerRuntimeID.make("worker_runtime_outbox_first")
    const secondRuntime = Work.WorkerRuntimeID.make("worker_runtime_outbox_second")
    const output = {
      result: Work.WorkerCommandResult.make({ type: "command", exitCode: 0, outputTruncated: false }),
      artifacts: [],
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = makeJob(firstRuntime, 1, false)
        expect(yield* prepareOutbox(makeInput(firstRuntime), first)).toBeUndefined()
        expect(yield* outboxReady()).toEqual([])
        expect((yield* prepareOutbox(makeInput(firstRuntime), first).pipe(Effect.exit))._tag).toBe("Failure")
        yield* saveOutbox(makeInput(firstRuntime), first, output)
        expect(yield* outboxReady()).toEqual([first.id])
        expect(yield* prepareOutbox(makeInput(secondRuntime), makeJob(secondRuntime, 2, true))).toEqual(output)
        yield* removeOutbox(first.id)
        expect(yield* outboxReady()).toEqual([])
      }).pipe(Effect.provide(AppNodeBuilder.build(database)), Effect.scoped),
    )
  })
})

async function git(directory: string, args: ReadonlyArray<string>) {
  const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const output = await new Response(child.stdout).text()
  const error = await new Response(child.stderr).text()
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${error}`)
  return output
}

async function gitCode(directory: string, args: ReadonlyArray<string>) {
  return Bun.spawn(["git", ...args], { cwd: directory, stdout: "ignore", stderr: "ignore" }).exited
}
