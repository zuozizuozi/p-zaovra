export * as WorkWorkerRuntime from "./runtime"

import { AppProcess } from "@zaovra-ai/core/process"
import { Database } from "@zaovra-ai/core/database/database"
import { makeGlobalNode } from "@zaovra-ai/core/effect/app-node"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { httpClient } from "@zaovra-ai/core/effect/app-node-platform"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Global } from "@zaovra-ai/core/global"
import { buildLocationServiceMap } from "@zaovra-ai/core/location-services"
import { LocationServiceMap } from "@zaovra-ai/core/location-service-map"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionExecutionLocal } from "@zaovra-ai/core/session/execution/local"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { Work } from "@zaovra-ai/core/work"
import { WorkExecution } from "@zaovra-ai/core/work/execution"
import { WorkExecutionLocal } from "@zaovra-ai/core/work/execution-local"
import { WorkLease } from "@zaovra-ai/core/work/lease"
import { WorkRemoteJob } from "@zaovra-ai/core/work/remote-job"
import { WorkRecovery } from "@zaovra-ai/core/work/recovery"
import { WorkWorker } from "@zaovra-ai/core/work/worker"
import { WorkWorkerJobOutboxTable } from "@zaovra-ai/core/work/sql"
import { asc, eq } from "drizzle-orm"
import { Cause, Clock, DateTime, Duration, Effect, Exit, Fiber, Ref, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { mkdir, stat } from "node:fs/promises"
import path from "path"

export type Input = {
  readonly controller: string
  readonly workerID: Work.WorkerID
  readonly runtimeID: Work.WorkerRuntimeID
  readonly token: string
  readonly mode: Work.WorkerExecutionMode
  readonly database?: string
  readonly username: string
  readonly password?: string
  readonly label: string
  readonly endpoint?: string
  readonly capabilities: ReadonlyArray<Work.WorkerCapability>
  readonly workspaceRoots: ReadonlyArray<string>
  readonly capacity: number
}

export class AuthenticationError extends Schema.TaggedErrorClass<AuthenticationError>()(
  "WorkWorkerRuntime.AuthenticationError",
  { message: Schema.String },
) {}

export class PollError extends Schema.TaggedErrorClass<PollError>()("WorkWorkerRuntime.PollError", {
  message: Schema.String,
}) {}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("WorkWorkerRuntime.StorageError", {
  message: Schema.String,
}) {}

export class ConfigurationError extends Schema.TaggedErrorClass<ConfigurationError>()(
  "WorkWorkerRuntime.ConfigurationError",
  { message: Schema.String },
) {}

export class JobLeaseLostError extends Schema.TaggedErrorClass<JobLeaseLostError>()(
  "WorkWorkerRuntime.JobLeaseLostError",
  { jobID: Work.WorkerJobID, message: Schema.String },
) {}

const PollResponse = Schema.Struct({ data: Work.WorkerPollInfo })
const ArtifactResponse = Schema.Struct({ data: Work.ArtifactReference })

export type OperationOutput = {
  readonly result: Work.WorkerJobResult
  readonly artifacts: ReadonlyArray<Work.WorkerPendingArtifact>
}
type OutputObserver = (message: string) => Effect.Effect<void, AuthenticationError | PollError | JobLeaseLostError>

export const run = Effect.fn("WorkWorkerRuntime.run")(function* (input: Input) {
  yield* requireSecureController(input)
  if (input.mode === "remote") {
    if (input.database)
      return yield* new ConfigurationError({ message: "Remote Worker mode must not use a shared database" })
    const root = path.join(Global.Path.data, "workers", input.workerID.replace(/[^a-zA-Z0-9._-]/g, "-"))
    yield* Effect.tryPromise({ try: () => mkdir(root, { recursive: true }), catch: (error) => error }).pipe(
      Effect.mapError(
        (error) => new StorageError({ message: `Unable to create Worker state directory: ${errorText(error)}` }),
      ),
    )
    const database = makeGlobalNode({
      service: Database.Service,
      layer: Database.layerFromPath(path.join(root, "runtime.db")),
      deps: [],
    })
    const locationServiceMap = buildLocationServiceMap([[Database.node, database]])
    return yield* remoteLoop(input).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([AppProcess.node, SessionV2.node]), [
          [Database.node, database],
          [LocationServiceMap.node, locationServiceMap],
          [SessionExecution.node, SessionExecutionLocal.node],
        ]),
      ),
    )
  }

  const registration = {
    id: input.workerID,
    label: input.label,
    endpoint: input.endpoint,
    capabilities: input.capabilities,
    workspaceRoots: input.workspaceRoots,
    runtimeID: input.runtimeID,
    capacity: input.capacity,
    executionMode: "shared" as const,
  }
  const database = input.database
    ? makeGlobalNode({
        service: Database.Service,
        layer: Database.layerFromPath(path.resolve(input.database)),
        deps: [],
      })
    : Database.node
  const worker = makeGlobalNode({
    service: WorkWorker.Service,
    layer: WorkWorker.makeLayer({ local: registration, automatic: false, registerLocal: false }),
    deps: [Database.node],
  })
  const lease = makeGlobalNode({
    service: WorkLease.Service,
    layer: WorkLease.makeLayer({ workerID: input.workerID, proxyRemote: false, requireController: true }),
    deps: [Database.node],
  })
  const services = LayerNode.group([
    httpClient,
    LocationServiceMap.node,
    WorkExecution.node,
    WorkRecovery.node,
    WorkWorker.node,
  ])
  const replacements: LayerNode.Replacements = [
    ...(input.database ? ([[Database.node, database]] as const) : []),
    [WorkWorker.node, worker],
    [WorkLease.node, lease],
    [SessionExecution.node, SessionExecutionLocal.node],
    [WorkExecution.node, WorkExecutionLocal.node],
  ]
  return yield* sharedLoop(input).pipe(Effect.provide(AppNodeBuilder.build(services, replacements)))
})

const sharedLoop = Effect.fn("WorkWorkerRuntime.sharedLoop")(function* (input: Input) {
  const execution = yield* WorkExecution.Service
  const recovery = yield* WorkRecovery.Service
  const workers = yield* WorkWorker.Service

  yield* Effect.forever(
    poll(input).pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          yield* requireMode(input, response)
          const observed = yield* workers.get(input.workerID)
          if (
            !observed ||
            DateTime.toEpochMillis(observed.heartbeatAt) < DateTime.toEpochMillis(response.worker.heartbeatAt)
          )
            yield* new StorageError({
              message:
                "Worker and controller are not observing the same durable database. Shared mode requires one SQLite/WAL path.",
            })
          if (response.assignments.some((assignment) => assignment.action === "recover")) yield* recovery.recover()
          yield* Effect.forEach(
            response.assignments.filter((assignment) => assignment.action === "wake"),
            (assignment) => execution.wake(assignment.goalID),
            { discard: true },
          )
          yield* Effect.sleep(response.pollAfterMs)
        }),
      ),
      Effect.catchTag("WorkWorkerRuntime.PollError", (error) =>
        Effect.logWarning(error.message).pipe(Effect.andThen(Effect.sleep(2_000))),
      ),
    ),
  )
})

const remoteLoop = Effect.fn("WorkWorkerRuntime.remoteLoop")(function* (input: Input) {
  const appProcess = yield* AppProcess.Service
  const sessions = yield* SessionV2.Service
  const active = new Map<Work.WorkerJobID, { readonly fence: number; readonly cancel: Effect.Effect<void> }>()
  const cancelled = new Set<Work.WorkerJobID>()
  yield* Effect.forever(
    poll(input).pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          yield* requireMode(input, response)
          yield* Effect.forEach(
            response.settledJobs,
            (jobID) => removeOutbox(jobID).pipe(Effect.tap(() => Effect.sync(() => cancelled.delete(jobID)))),
            { concurrency: 1, discard: true },
          )
          yield* Effect.forEach(
            response.cancellations,
            (cancellation) => {
              cancelled.add(cancellation.id)
              const running = active.get(cancellation.id)
              if (!running || running.fence !== cancellation.fence) return Effect.void
              return running.cancel
            },
            { concurrency: "unbounded", discard: true },
          )
          yield* Effect.forEach(
            response.jobs,
            (job) => {
              if (active.has(job.id)) return Effect.void
              return Effect.gen(function* () {
                const fiber = yield* executeRemoteJob(
                  appProcess,
                  sessions,
                  response.worker,
                  input,
                  job,
                  cancelled.has(job.id),
                ).pipe(
                  Effect.ensuring(Effect.sync(() => active.delete(job.id))),
                  Effect.catchTag("WorkWorkerRuntime.PollError", (error) => Effect.logWarning(error.message)),
                  Effect.catchTag("WorkWorkerRuntime.StorageError", (error) => Effect.logError(error.message)),
                  Effect.catchTag("WorkWorkerRuntime.JobLeaseLostError", (error) =>
                    Effect.logWarning(error.message, { jobID: error.jobID }),
                  ),
                  Effect.forkChild,
                )
                active.set(job.id, { fence: job.fence, cancel: Fiber.interrupt(fiber).pipe(Effect.asVoid) })
              })
            },
            { concurrency: "unbounded", discard: true },
          )
          yield* Effect.sleep(response.pollAfterMs)
        }),
      ),
      Effect.catchTag("WorkWorkerRuntime.PollError", (error) =>
        Effect.logWarning(error.message).pipe(Effect.andThen(Effect.sleep(2_000))),
      ),
    ),
  )
})

const executeRemoteJob = Effect.fn("WorkWorkerRuntime.executeRemoteJob")(function* (
  appProcess: AppProcess.Interface,
  sessions: SessionV2.Interface,
  worker: Work.WorkerInfo,
  input: Input,
  job: Work.WorkerJobAssignment,
  cancelRequested = false,
) {
  const execution = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const stored = yield* prepareOutbox(input, job)
      const sequence = yield* Ref.make(job.nextLogSequence)
      const log = (stream: Work.WorkerJobLogStream, message: string) =>
        Ref.getAndUpdate(sequence, (value) => value + 1).pipe(
          Effect.flatMap((value) => reportLog(input, job, value, stream, message)),
          Effect.catchTag("WorkWorkerRuntime.PollError", (error) => Effect.logWarning(error.message)),
        )
      yield* log("system", `${stored ? "Recovering" : "Started"} ${job.operation.type} Job ${job.id}`)
      const cancellation =
        stored && cancelRequested
          ? interruptedOutput(job.operation, "Controller requested cancellation", true)
          : undefined
      if (cancellation) yield* saveOutbox(input, job, cancellation)
      const output =
        cancellation ??
        stored ??
        (yield* restore(
          job.operation.type === "agent"
            ? executeAgent(appProcess, sessions, worker, job.operation, (message) => log("output", message)).pipe(
                Effect.map((value) => value as OperationOutput),
              )
            : executeOperation(appProcess, worker, job.operation, (message) => log("output", message)).pipe(
                Effect.map((value) => value as OperationOutput),
              ),
        ).pipe(
          Effect.exit,
          Effect.map((exit) =>
            Exit.isSuccess(exit)
              ? exit.value
              : interruptedOutput(job.operation, errorText(Cause.squash(exit.cause)), Cause.hasInterrupts(exit.cause)),
          ),
          Effect.tap((value) => saveOutbox(input, job, value)),
        ))
      const uploaded = yield* Effect.forEach(output.artifacts, (artifact) => uploadArtifact(input, job, artifact))
      const result = attachArtifacts(output.result, uploaded)
      yield* Effect.forEach(resultLogs(result, job.operation.type !== "command"), (entry) =>
        log(entry.stream, entry.message),
      )
      yield* log(
        "system",
        result.error ? `Finished ${job.operation.type} Job with an execution error` : finishMessage(result),
      )
      yield* completeJob(input, job, result)
      yield* removeOutbox(job.id)
    }),
  )
  const renewal = Effect.forever(
    renewJob(input, job).pipe(
      Effect.catchTag("WorkWorkerRuntime.PollError", (error) =>
        Effect.logWarning(error.message, { jobID: job.id }).pipe(Effect.andThen(Effect.sleep(1_000))),
      ),
      Effect.andThen(Effect.sleep(5_000)),
    ),
  )
  yield* execution.pipe(Effect.raceFirst(renewal))
})

export const outboxReady = Effect.fn("WorkWorkerRuntime.outboxReady")(function* () {
  const db = (yield* Database.Service).db
  return (yield* db
    .select({ id: WorkWorkerJobOutboxTable.job_id })
    .from(WorkWorkerJobOutboxTable)
    .where(eq(WorkWorkerJobOutboxTable.state, "result_ready"))
    .orderBy(asc(WorkWorkerJobOutboxTable.time_updated), asc(WorkWorkerJobOutboxTable.job_id))
    .limit(32)
    .all()
    .pipe(Effect.orDie)).map((row) => row.id)
})

export const prepareOutbox = Effect.fn("WorkWorkerRuntime.prepareOutbox")(function* (
  input: Input,
  job: Work.WorkerJobAssignment,
) {
  const db = (yield* Database.Service).db
  const current = yield* db
    .select()
    .from(WorkWorkerJobOutboxTable)
    .where(eq(WorkWorkerJobOutboxTable.job_id, job.id))
    .get()
    .pipe(Effect.orDie)
  if (current) {
    if (current.worker_id !== input.workerID || !sameJson(current.operation, job.operation))
      return yield* new StorageError({ message: `Worker Job outbox identity conflicts with ${job.id}` })
    if (current.state !== "result_ready" || !current.result)
      return yield* new StorageError({
        message: `Worker Job ${job.id} stopped before a durable result boundary and cannot be replayed`,
      })
    yield* db
      .update(WorkWorkerJobOutboxTable)
      .set({ runtime_id: input.runtimeID, fence: job.fence, time_updated: yield* Clock.currentTimeMillis })
      .where(eq(WorkWorkerJobOutboxTable.job_id, job.id))
      .run()
      .pipe(Effect.orDie)
    return { result: current.result, artifacts: current.artifacts } satisfies OperationOutput
  }
  yield* db
    .insert(WorkWorkerJobOutboxTable)
    .values({
      job_id: job.id,
      worker_id: input.workerID,
      runtime_id: input.runtimeID,
      fence: job.fence,
      operation: job.operation,
      state: "executing",
      artifacts: [],
      time_updated: yield* Clock.currentTimeMillis,
    })
    .run()
    .pipe(Effect.orDie)
  return undefined
})

export const saveOutbox = Effect.fn("WorkWorkerRuntime.saveOutbox")(function* (
  input: Input,
  job: Work.WorkerJobAssignment,
  output: OperationOutput,
) {
  const db = (yield* Database.Service).db
  const updated = yield* db
    .update(WorkWorkerJobOutboxTable)
    .set({
      runtime_id: input.runtimeID,
      fence: job.fence,
      state: "result_ready",
      result: output.result,
      artifacts: Array.from(output.artifacts),
      time_updated: yield* Clock.currentTimeMillis,
    })
    .where(eq(WorkWorkerJobOutboxTable.job_id, job.id))
    .returning({ id: WorkWorkerJobOutboxTable.job_id })
    .get()
    .pipe(Effect.orDie)
  if (!updated)
    return yield* new StorageError({ message: `Worker Job outbox disappeared before settlement: ${job.id}` })
  return undefined
})

export const removeOutbox = Effect.fn("WorkWorkerRuntime.removeOutbox")(function* (jobID: Work.WorkerJobID) {
  const db = (yield* Database.Service).db
  yield* db.delete(WorkWorkerJobOutboxTable).where(eq(WorkWorkerJobOutboxTable.job_id, jobID)).run().pipe(Effect.orDie)
})

function interruptedOutput(
  operation: Work.WorkerJobOperation,
  error: string,
  wasInterrupted: boolean,
): OperationOutput {
  if (operation.type === "command")
    return {
      result: Work.WorkerCommandResult.make({
        type: "command",
        ...(wasInterrupted ? { interrupted: true } : {}),
        error,
        outputTruncated: false,
        ...(operation.artifactCapture ? { baseRevision: operation.artifactCapture.baseRevision } : {}),
      }),
      artifacts: [],
    }
  if (operation.type === "file") return { result: Work.WorkerFileResult.make({ type: "file", error }), artifacts: [] }
  return {
    result: Work.WorkerAgentResult.make({
      type: "agent",
      sessionID: operation.sessionID,
      status: wasInterrupted ? "interrupted" : "unknown",
      outputTruncated: false,
      stepCount: 0,
      toolCallCount: 0,
      error,
      baseRevision: operation.artifactCapture.baseRevision,
      artifactError: error,
    }),
    artifacts: [],
  }
}

export const executeOperation = Effect.fn("WorkWorkerRuntime.executeOperation")(function* (
  appProcess: AppProcess.Interface,
  worker: Work.WorkerInfo,
  operation: Work.WorkerCommandOperation | Work.WorkerFileOperation,
  observe?: OutputObserver,
) {
  const directory = mapDirectory(operation.location.directory, worker.locationMappings)
  if (!directory)
    return {
      result: unavailable(operation, `No Worker Location mapping for ${operation.location.directory}`),
      artifacts: [],
    }
  if (operation.type === "file") return { result: yield* executeFile(operation, directory), artifacts: [] }

  if (operation.artifactCapture) {
    const ready = yield* prepareCapture(appProcess, directory, operation.artifactCapture)
    if (ready)
      return {
        result: Work.WorkerCommandResult.make({
          type: "command",
          error: ready,
          outputTruncated: false,
          baseRevision: operation.artifactCapture.baseRevision,
        }),
        artifacts: [],
      }
  }

  const command = ChildProcess.make(operation.command, [], {
    cwd: directory,
    shell: process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh",
    stdin: "ignore",
    detached: process.platform !== "win32",
    forceKillAfter: Duration.seconds(3),
  })
  const exit = yield* (
    observe
      ? runObservedCommand(
          appProcess,
          command,
          operation.command,
          operation.timeoutMs,
          operation.maxOutputBytes,
          observe,
        )
      : appProcess.run(command, {
          combineOutput: true,
          timeout: Duration.millis(operation.timeoutMs),
          maxOutputBytes: operation.maxOutputBytes,
        })
  ).pipe(Effect.exit)
  const result = Exit.isFailure(exit)
    ? Work.WorkerCommandResult.make({
        type: "command",
        ...(Cause.hasInterrupts(exit.cause) ? { interrupted: true } : {}),
        error: errorText(Cause.squash(exit.cause)),
        outputTruncated: false,
      })
    : Work.WorkerCommandResult.make({
        type: "command",
        exitCode: exit.value.exitCode,
        output: exit.value.output?.toString("utf8") ?? "",
        outputTruncated: exit.value.outputTruncated === true,
      })
  if (!operation.artifactCapture) return { result, artifacts: [] }

  const captured = yield* captureDiff(appProcess, directory, operation.artifactCapture)
  if (captured.error)
    return {
      result: Work.WorkerCommandResult.make({
        ...result,
        baseRevision: operation.artifactCapture.baseRevision,
        artifactError: captured.error,
      }),
      artifacts: [],
    }
  return {
    result: Work.WorkerCommandResult.make({ ...result, baseRevision: operation.artifactCapture.baseRevision }),
    artifacts: captured.content ? [{ label: "workspace.patch", content: captured.content }] : [],
  }
})

export const executeAgent = Effect.fn("WorkWorkerRuntime.executeAgent")(function* (
  appProcess: AppProcess.Interface,
  sessions: SessionV2.Interface,
  worker: Work.WorkerInfo,
  operation: Work.WorkerAgentOperation,
  observe?: OutputObserver,
) {
  const directory = mapDirectory(operation.location.directory, worker.locationMappings)
  if (!directory)
    return {
      result: unavailable(operation, `No Worker Location mapping for ${operation.location.directory}`),
      artifacts: [],
    }
  const ready = yield* prepareCapture(appProcess, directory, operation.artifactCapture)
  if (ready)
    return {
      result: Work.WorkerAgentResult.make({
        type: "agent",
        sessionID: operation.sessionID,
        status: "failed",
        outputTruncated: false,
        stepCount: 0,
        toolCallCount: 0,
        error: ready,
        baseRevision: operation.artifactCapture.baseRevision,
        artifactError: ready,
      }),
      artifacts: [],
    }

  const local = { directory: AbsolutePath.make(directory) }
  const session = yield* sessions.create({ id: operation.sessionID, location: local, agent: operation.agent })
  if (session.location.directory !== local.directory || session.agent !== operation.agent)
    return {
      result: Work.WorkerAgentResult.make({
        type: "agent",
        sessionID: operation.sessionID,
        status: "failed",
        outputTruncated: false,
        stepCount: 0,
        toolCallCount: 0,
        error: `Worker Session identity conflicts with Agent Job ${operation.sessionID}`,
        baseRevision: operation.artifactCapture.baseRevision,
        artifactError: `Worker Session identity conflicts with Agent Job ${operation.sessionID}`,
      }),
      artifacts: [],
    }

  const exit = yield* Effect.scoped(
    Effect.gen(function* () {
      const observer = observe
        ? yield* sessions.events({ sessionID: operation.sessionID }).pipe(
            Stream.runForEach((event) => {
              const message = sessionEventLog(event)
              return message ? observe(message) : Effect.void
            }),
            Effect.forkScoped,
          )
        : undefined
      const result = yield* sessions
        .prompt({
          id: SessionMessage.ID.make(`msg_${operation.sessionID.slice("ses_".length)}`),
          sessionID: operation.sessionID,
          prompt: { text: operation.prompt },
          resume: false,
        })
        .pipe(Effect.andThen(sessions.resume(operation.sessionID)), Effect.exit)
      if (observer) yield* Fiber.interrupt(observer)
      return result
    }),
  )
  const messages = yield* sessions
    .messages({ sessionID: operation.sessionID, order: "desc" })
    .pipe(Effect.catch(() => Effect.succeed([])))
  const assistants = messages.reduce<SessionMessage.Assistant[]>(
    (result, message) => (message.type === "assistant" ? [...result, message] : result),
    [],
  )
  const response = assistants[0]
  const fullResponse = response
    ? response.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\n")
    : ""
  const bounded = boundedResult(fullResponse)
  const status = Exit.isFailure(exit)
    ? Cause.hasInterrupts(exit.cause)
      ? "interrupted"
      : "failed"
    : response?.error
      ? "failed"
      : response
        ? "succeeded"
        : "failed"
  const captured = yield* captureDiff(appProcess, directory, operation.artifactCapture)
  const content = captured.content ?? ""
  const error = Exit.isFailure(exit)
    ? errorText(Cause.squash(exit.cause))
    : (response?.error?.message ?? (response ? undefined : "Agent Session produced no assistant response"))
  return {
    result: Work.WorkerAgentResult.make({
      type: "agent",
      sessionID: operation.sessionID,
      status,
      ...(response ? { finalResponse: bounded.text, responseDigest: hash(bounded.text) } : {}),
      outputTruncated: bounded.truncated,
      stepCount: assistants.length,
      toolCallCount: assistants.flatMap((message) => message.content).filter((content) => content.type === "tool")
        .length,
      ...(error ? { error } : {}),
      baseRevision: operation.artifactCapture.baseRevision,
      ...(captured.error ? { artifactError: captured.error } : { workspaceDigest: hash(content) }),
    }),
    artifacts: captured.content ? [{ label: "workspace.patch", content: captured.content }] : [],
  }
})

const runObservedCommand = Effect.fn("WorkWorkerRuntime.runObservedCommand")(function* (
  appProcess: AppProcess.Interface,
  command: ChildProcess.Command,
  commandName: string,
  timeoutMs: number,
  maxOutputBytes: number,
  observe: OutputObserver,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* appProcess.spawn(command)
      const [output, exitCode] = yield* Effect.all(
        [
          Stream.runFoldEffect(
            handle.all,
            () => ({ chunks: [] as Uint8Array[], bytes: 0, truncated: false }),
            (state, chunk) => {
              const remaining = Math.max(0, maxOutputBytes - Math.min(state.bytes, maxOutputBytes))
              const accepted = remaining >= chunk.byteLength ? chunk : chunk.slice(0, remaining)
              const next = {
                chunks: accepted.byteLength > 0 ? [...state.chunks, accepted] : state.chunks,
                bytes: state.bytes + chunk.byteLength,
                truncated: state.truncated || accepted.byteLength < chunk.byteLength,
              }
              if (accepted.byteLength === 0) return Effect.succeed(next)
              return observe(new TextDecoder().decode(accepted)).pipe(Effect.as(next))
            },
          ),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      )
      return {
        command: commandName,
        exitCode,
        output: Buffer.concat(output.chunks),
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        outputTruncated: output.truncated,
        stdoutTruncated: false,
        stderrTruncated: false,
      }
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () => Effect.fail(new Error(`Remote command timed out after ${timeoutMs}ms`)),
    }),
  )
})

const executeFile = Effect.fn("WorkWorkerRuntime.executeFile")(function* (
  operation: Work.WorkerFileOperation,
  directory: string,
) {
  const target = path.resolve(directory, operation.path)
  if (!contains(directory, target))
    return Work.WorkerFileResult.make({ type: "file", target, actual: "outside_workspace" })
  const result = yield* Effect.tryPromise({ try: () => stat(target), catch: (error) => error }).pipe(Effect.exit)
  if (Exit.isFailure(result)) {
    const error = Cause.squash(result.cause)
    if (errorCode(error) === "ENOENT") return Work.WorkerFileResult.make({ type: "file", target, actual: "missing" })
    return Work.WorkerFileResult.make({ type: "file", target, error: errorText(error) })
  }
  return Work.WorkerFileResult.make({
    type: "file",
    target,
    actual: result.value.isFile() ? "file" : result.value.isDirectory() ? "directory" : "other",
  })
})

const prepareCapture = Effect.fn("WorkWorkerRuntime.prepareCapture")(function* (
  appProcess: AppProcess.Interface,
  directory: string,
  capture: Work.WorkerGitDiffCapture,
) {
  const revision = yield* runGit(appProcess, directory, ["rev-parse", "HEAD"], 4_096)
  if (revision.error || revision.exitCode !== 0)
    return `Unable to read the remote Git revision: ${revision.error ?? revision.output}`
  const actual = revision.output.trim()
  if (actual !== capture.baseRevision)
    return `Remote workspace revision ${actual || "unknown"} does not match required revision ${capture.baseRevision}`
  if (capture.startDigest) {
    const current = yield* captureDiff(appProcess, directory, capture)
    if (current.error) return `Unable to verify the remote starting workspace: ${current.error}`
    const digest = hash(current.content ?? "")
    if (digest !== capture.startDigest)
      return `Remote workspace digest ${digest} does not match required starting digest ${capture.startDigest}`
    return undefined
  }
  const status = yield* runGit(appProcess, directory, ["status", "--porcelain", "--untracked-files=all"], 64 * 1024)
  if (status.error || status.exitCode !== 0)
    return `Unable to inspect the remote Git workspace: ${status.error ?? status.output}`
  if (status.output.trim()) return "Remote workspace must be clean before a content-addressed patch capture"
  return undefined
})

const captureDiff = Effect.fn("WorkWorkerRuntime.captureDiff")(function* (
  appProcess: AppProcess.Interface,
  directory: string,
  capture: Work.WorkerGitDiffCapture,
) {
  const intent = yield* runGit(appProcess, directory, ["add", "-N", "--", "."], 64 * 1024)
  if (intent.error || intent.exitCode !== 0)
    return { error: `Unable to prepare new files for patch capture: ${intent.error ?? intent.output}` }
  const diff = yield* runGit(
    appProcess,
    directory,
    ["diff", "--binary", "--no-ext-diff", "HEAD", "--"],
    Math.min(capture.maxBytes, WorkRemoteJob.maxArtifactBytes),
  )
  const reset = yield* runGit(appProcess, directory, ["reset", "--mixed", "--quiet", "HEAD"], 64 * 1024)
  if (reset.error || reset.exitCode !== 0)
    return { error: `Unable to restore the remote Git index after patch capture: ${reset.error ?? reset.output}` }
  if (diff.error || diff.exitCode !== 0)
    return { error: `Unable to capture the remote workspace patch: ${diff.error ?? diff.output}` }
  if (diff.outputTruncated)
    return {
      error: `Remote workspace patch exceeds the ${Math.min(capture.maxBytes, WorkRemoteJob.maxArtifactBytes)} byte limit`,
    }
  return { content: diff.output }
})

const runGit = Effect.fn("WorkWorkerRuntime.runGit")(function* (
  appProcess: AppProcess.Interface,
  directory: string,
  args: ReadonlyArray<string>,
  maxOutputBytes: number,
) {
  const result = yield* appProcess
    .run(
      ChildProcess.make("git", args, {
        cwd: directory,
        stdin: "ignore",
        detached: process.platform !== "win32",
        forceKillAfter: Duration.seconds(3),
      }),
      { combineOutput: true, timeout: Duration.seconds(30), maxOutputBytes },
    )
    .pipe(Effect.exit)
  if (Exit.isFailure(result))
    return { error: errorText(Cause.squash(result.cause)), exitCode: undefined, output: "", outputTruncated: false }
  return {
    error: undefined,
    exitCode: result.value.exitCode,
    output: result.value.output?.toString("utf8") ?? "",
    outputTruncated: result.value.outputTruncated === true,
  }
})

const poll = Effect.fn("WorkWorkerRuntime.poll")(function* (input: Input) {
  const recoverableJobIDs = yield* outboxReady()
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(`${controller(input)}/api/work/workers/${input.workerID}/poll`, {
        method: "POST",
        headers: headers(input),
        body: JSON.stringify({
          runtimeID: input.runtimeID,
          label: input.label,
          endpoint: input.endpoint,
          capabilities: input.capabilities,
          workspaceRoots: input.workspaceRoots,
          capacity: input.capacity,
          recoverableJobIDs,
        }),
      }),
    catch: (error) => new PollError({ message: `Worker poll failed: ${String(error)}` }),
  })
  yield* requireResponse(response, "Worker poll")
  return yield* Schema.decodeUnknownEffect(PollResponse)(yield* Effect.promise(() => response.json())).pipe(
    Effect.map((value) => value.data),
    Effect.mapError(
      (error) => new PollError({ message: `Controller returned an invalid Worker poll: ${error.message}` }),
    ),
  )
})

const renewJob = Effect.fn("WorkWorkerRuntime.renewJob")(function* (input: Input, job: Work.WorkerJobAssignment) {
  const response = yield* requestJob(input, job, "heartbeat", { fence: job.fence })
  if (response.status === 409)
    return yield* new JobLeaseLostError({ jobID: job.id, message: `Remote Worker Job lease lost: ${job.id}` })
  yield* requireResponse(response, "Remote Worker Job heartbeat")
  return undefined
})

const reportLog = Effect.fn("WorkWorkerRuntime.reportLog")(function* (
  input: Input,
  job: Work.WorkerJobAssignment,
  sequence: number,
  stream: Work.WorkerJobLogStream,
  message: string,
) {
  const response = yield* requestJob(input, job, "logs", {
    fence: job.fence,
    sequence,
    stream,
    message: boundedLog(message),
  })
  if (response.status === 409)
    return yield* new JobLeaseLostError({ jobID: job.id, message: `Remote Worker Job log was fenced: ${job.id}` })
  yield* requireResponse(response, "Remote Worker Job log")
  return undefined
})

const uploadArtifact = Effect.fn("WorkWorkerRuntime.uploadArtifact")(function* (
  input: Input,
  job: Work.WorkerJobAssignment,
  artifact: Work.WorkerPendingArtifact,
) {
  const contentSize = size(artifact.content)
  const response = yield* requestJob(input, job, "artifacts", {
    fence: job.fence,
    label: artifact.label,
    digest: hash(artifact.content),
    size: contentSize,
    content: artifact.content,
  })
  if (response.status === 409)
    return yield* new JobLeaseLostError({
      jobID: job.id,
      message: `Remote Worker Job artifact was fenced or rejected: ${job.id}`,
    })
  yield* requireResponse(response, "Remote Worker Job artifact upload")
  return yield* Schema.decodeUnknownEffect(ArtifactResponse)(yield* Effect.promise(() => response.json())).pipe(
    Effect.map((value) => value.data),
    Effect.mapError(
      (error) => new PollError({ message: `Controller returned an invalid Worker artifact: ${error.message}` }),
    ),
  )
})

const completeJob = Effect.fn("WorkWorkerRuntime.completeJob")(function* (
  input: Input,
  job: Work.WorkerJobAssignment,
  result: Work.WorkerJobResult,
) {
  const response = yield* requestJob(input, job, "complete", { fence: job.fence, result })
  if (response.status === 409)
    return yield* new JobLeaseLostError({ jobID: job.id, message: `Remote Worker Job result was fenced: ${job.id}` })
  yield* requireResponse(response, "Remote Worker Job completion")
  return undefined
})

function requestJob(
  input: Input,
  job: Work.WorkerJobAssignment,
  action: "heartbeat" | "logs" | "artifacts" | "complete",
  body: Record<string, unknown>,
) {
  return Effect.tryPromise({
    try: () =>
      fetch(`${controller(input)}/api/work/workers/${input.workerID}/jobs/${job.id}/${action}`, {
        method: "POST",
        headers: headers(input),
        body: JSON.stringify({ runtimeID: input.runtimeID, ...body }),
      }),
    catch: (error) => new PollError({ message: `Remote Worker Job ${action} failed: ${String(error)}` }),
  })
}

const requireResponse = Effect.fn("WorkWorkerRuntime.requireResponse")(function* (
  response: Response,
  operation: string,
) {
  if (response.status === 401 || response.status === 403)
    return yield* new AuthenticationError({ message: `Controller rejected the Worker credential during ${operation}` })
  if (!response.ok)
    return yield* new PollError({
      message: `${operation} failed (${response.status}): ${(yield* Effect.promise(() => response.text())).slice(0, 1_000)}`,
    })
  return undefined
})

const requireMode = Effect.fn("WorkWorkerRuntime.requireMode")(function* (input: Input, response: Work.WorkerPollInfo) {
  if (response.worker.executionMode !== input.mode)
    return yield* new ConfigurationError({
      message: `Worker is enrolled as ${response.worker.executionMode}, but this process started in ${input.mode} mode`,
    })
  if (response.worker.runtimeID !== input.runtimeID)
    return yield* new ConfigurationError({
      message: `Worker runtime ${input.runtimeID} is fenced by active runtime ${response.worker.runtimeID ?? "unknown"}`,
    })
  if (response.worker.capacity !== input.capacity)
    return yield* new ConfigurationError({
      message: `Controller registered Worker capacity ${response.worker.capacity}, but this process requested ${input.capacity}`,
    })
  return undefined
})

const requireSecureController = Effect.fn("WorkWorkerRuntime.requireSecureController")(function* (input: Input) {
  const url = URL.parse(input.controller)
  if (!url) return yield* new ConfigurationError({ message: `Invalid controller URL: ${input.controller}` })
  if (isSecureController(input.controller)) return undefined
  return yield* new ConfigurationError({ message: "Remote Worker controllers must use HTTPS outside localhost" })
})

function controller(input: Input) {
  return input.controller.replace(/\/$/, "")
}

function headers(input: Input) {
  return {
    "content-type": "application/json",
    "x-zaovra-worker-token": input.token,
    ...(input.password
      ? { authorization: `Basic ${Buffer.from(`${input.username}:${input.password}`).toString("base64")}` }
      : {}),
  }
}

export function mapDirectory(directory: string, mappings: ReadonlyArray<Work.WorkerLocationMapping>) {
  const source = portable(directory)
  const mapping = mappings
    .filter((candidate) => {
      const root = portable(candidate.controllerRoot)
      return equal(source, root) || startsWith(source, `${root}/`)
    })
    .toSorted((a, b) => portable(b.controllerRoot).length - portable(a.controllerRoot).length)[0]
  if (!mapping) return undefined
  const root = portable(mapping.controllerRoot)
  const target = path.resolve(mapping.workerRoot, ...source.slice(root.length).split("/").filter(Boolean))
  return contains(path.resolve(mapping.workerRoot), target) ? target : undefined
}

export function isSecureController(value: string) {
  const url = URL.parse(value)
  return Boolean(
    url &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))),
  )
}

function portable(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "")
}

function comparable(value: string) {
  const normalized = portable(value)
  return /^[a-z]:/i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
}

function equal(left: string, right: string) {
  return comparable(left) === comparable(right)
}

function startsWith(value: string, prefix: string) {
  return comparable(value).startsWith(comparable(prefix))
}

function contains(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function attachArtifacts(result: Work.WorkerJobResult, artifacts: ReadonlyArray<Work.ArtifactReference>) {
  if (artifacts.length === 0) return result
  if (result.type === "command") return Work.WorkerCommandResult.make({ ...result, artifacts: Array.from(artifacts) })
  if (result.type === "agent") return Work.WorkerAgentResult.make({ ...result, artifacts: Array.from(artifacts) })
  return result
}

function resultLogs(result: Work.WorkerJobResult, includeOutput: boolean) {
  if (result.type === "file") return result.error ? [{ stream: "error" as const, message: result.error }] : []
  if (result.type === "agent")
    return [
      ...(includeOutput && result.finalResponse ? [{ stream: "output" as const, message: result.finalResponse }] : []),
      ...(result.error ? [{ stream: "error" as const, message: result.error }] : []),
      ...(result.artifactError ? [{ stream: "error" as const, message: result.artifactError }] : []),
    ]
  return [
    ...(includeOutput && result.output ? [{ stream: "output" as const, message: result.output }] : []),
    ...(result.error ? [{ stream: "error" as const, message: result.error }] : []),
    ...(result.artifactError ? [{ stream: "error" as const, message: result.artifactError }] : []),
  ]
}

function finishMessage(result: Work.WorkerJobResult) {
  if (result.type === "command") return `Finished command Job with exit code ${result.exitCode ?? "unknown"}`
  if (result.type === "agent")
    return `Finished Agent Job with ${result.stepCount} provider step(s) and ${result.toolCallCount} tool call(s)`
  return `Finished file Job with result ${result.actual ?? "unknown"}`
}

function boundedLog(value: string) {
  if (size(value) <= WorkRemoteJob.maxLogBytes) return value
  const marker = "\n[ZAOVRA remote log truncated]"
  const bytes = new TextEncoder().encode(value)
  return `${new TextDecoder().decode(bytes.slice(0, WorkRemoteJob.maxLogBytes - size(marker)))}${marker}`
}

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function size(value: string) {
  return new TextEncoder().encode(value).byteLength
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function unavailable(operation: Work.WorkerJobOperation, error: string): Work.WorkerJobResult {
  if (operation.type === "command")
    return Work.WorkerCommandResult.make({ type: operation.type, error, outputTruncated: false })
  if (operation.type === "file") return Work.WorkerFileResult.make({ type: operation.type, error })
  return Work.WorkerAgentResult.make({
    type: operation.type,
    sessionID: operation.sessionID,
    status: "unknown",
    outputTruncated: false,
    stepCount: 0,
    toolCallCount: 0,
    error,
  })
}

function sessionEventLog(event: SessionEvent.DurableEvent) {
  if (event.type === SessionEvent.Step.Started.type)
    return `Agent step started: ${event.data.agent} using ${event.data.model.providerID}/${event.data.model.id}`
  if (event.type === SessionEvent.Step.Ended.type) return `Agent step finished: ${event.data.finish}`
  if (event.type === SessionEvent.Step.Failed.type) return `Agent step failed: ${event.data.error.message}`
  if (event.type === SessionEvent.Tool.Called.type) return `Tool called: ${event.data.tool}`
  if (event.type === SessionEvent.Tool.Success.type) return `Tool completed: ${event.data.callID}`
  if (event.type === SessionEvent.Tool.Failed.type)
    return `Tool failed: ${event.data.callID}: ${event.data.error.message}`
  if (event.type === SessionEvent.Text.Ended.type) return event.data.text
  return undefined
}

function boundedResult(value: string) {
  const limit = 192 * 1024
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= limit) return { text: value, truncated: false }
  const marker = "\n[ZAOVRA Agent response truncated]"
  return {
    text: `${new TextDecoder().decode(bytes.slice(0, limit - size(marker)))}${marker}`,
    truncated: true,
  }
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
