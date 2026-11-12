export * as BashJob from "./bash-job"

import { Cause, Clock, Context, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { SessionOutcome } from "@zaovra-ai/schema/session-outcome"
import { chineseTask, deliveredBackgroundResult, history, requested } from "../session/outcome"
import { Global } from "../global"
import { PreviewProcess } from "../preview-process"
import { AppProcess } from "../process"
import { BackgroundJob } from "../background-job"
import { Database } from "../database/database"
import { Config } from "../config"
import { SessionBudget } from "../session/budget"
import { SessionInput } from "../session/input"
import { SessionExecution } from "../session/execution"
import { EventV2 } from "../event"
import { makeLocationNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { SessionStore } from "../session/store"
import { Tool, withPermission } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"
import type { ToolOutputStore } from "../tool-output-store"

// Only producer-bounded command output may become conversation or model text.
export class CommandFailed extends Schema.TaggedErrorClass<CommandFailed>()("BashJob.CommandFailed", {
  output: Schema.String,
}) {
  override get message() {
    return this.output
  }
}

// A launch failure has no command output. Its errno name (ENOENT, ENAMETOOLONG) lets the model
// change approach; arbitrary error text stays in diagnostics because it may carry payloads.
function systemErrorCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 4) return
  if ("code" in error && typeof error.code === "string" && /^E[A-Z0-9_]{2,24}$/.test(error.code)) return error.code
  return systemErrorCode("cause" in error ? error.cause : undefined, depth + 1)
}

export class Service extends Context.Service<
  Service,
  {
    readonly watch: (id: string) => Effect.Effect<void>
    readonly record: (
      id: string,
      result: {
        executionRecord?: SessionOutcome.ExecutionRecord
        verification?: SessionOutcome.Check
        verifications?: readonly SessionOutcome.Check[]
      },
    ) => Effect.Effect<void>
    readonly start: (
      command: string,
      run: Effect.Effect<string, unknown>,
      context: Tool.Context,
      prepare: Effect.Effect<void, unknown>,
      background?: { kind: "task" | "preview"; workdir: string; observe?: ToolOutputStore.CaptureHandle["snapshot"] },
      onExisting?: Effect.Effect<void>,
    ) => Effect.Effect<string, Tool.Failure>
  }
>()("@zaovra/BashJob") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const global = yield* Global.Service
    const database = yield* Database.Service
    const config = yield* Config.Service
    const events = yield* EventV2.Service
    const sessions = yield* SessionStore.Service
    const location = yield* Location.Service
    const permissions = yield* PermissionV2.Service
    const tools = yield* Tools.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const owned = new Set<string>()
    const watched = new Set<string>()
    const notified = new Set<string>()
    const observations = new Map<string, ToolOutputStore.CaptureHandle["snapshot"]>()
    const stopped = new Set<string>()
    const unsubscribe = yield* events.listen((event) =>
      Effect.sync(() => {
        if (event.type === SessionExecution.Stopped.type)
          stopped.add(Schema.decodeUnknownSync(SessionExecution.Stopped.data)(event.data).sessionID)
        if (event.type === SessionEvent.PromptAdmitted.type) {
          // EventV2 listeners receive decoded payloads, including DateTime values.
          const input = Schema.decodeUnknownSync(Schema.toType(SessionEvent.PromptAdmitted.data))(event.data)
          if (!input.completion) stopped.delete(input.sessionID)
        }
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const notify = (id: string) =>
      locks.withLock(id)(
        Effect.gen(function* () {
          if (!watched.has(id) || notified.has(id)) return
          const job = yield* jobs.get(id)
          if (!job || job.status === "cancelled") {
            watched.delete(id)
            return
          }
          const record = yield* sessions.message(SessionMessage.ID.make(id))
          if (!record || record.message.type !== "shell" || !record.message.time.completed) return
          if (
            job.metadata?.kind === "preview" ||
            stopped.has(record.sessionID) ||
            (yield* sessions.get(record.sessionID))?.time.archived
          ) {
            watched.delete(id)
            return
          }
          if (yield* SessionInput.find(database.db, SessionMessage.ID.make(`${id}_completed`))) {
            watched.delete(id)
            notified.add(id)
            return
          }
          const messages = yield* history(database.db, record.sessionID)
          if (deliveredBackgroundResult(messages, id)) {
            watched.delete(id)
            return
          }
          const source = requested(messages).sourceMessageID
          if (source && job.metadata?.sourceMessageID && source !== job.metadata.sourceMessageID) {
            watched.delete(id)
            return
          }
          const exit = record.message.executionRecord?.exit
          const tail = observations.get(id)?.().output ?? record.message.output.slice(-8192)
          const result = `job_id=${id}; status=${exit === undefined ? "finished" : exit === 0 ? "completed" : "error"}; exit=${exit ?? "unknown"}`
          yield* SessionInput.admit(database.db, events, {
            id: SessionMessage.ID.make(`${id}_completed`),
            sessionID: record.sessionID,
            delivery: "queue",
            completion: {
              type: "bash-completion",
              sourceMessageID: SessionMessage.ID.make(
                typeof job.metadata?.sourceMessageID === "string" ? job.metadata.sourceMessageID : id,
              ),
              jobID: id,
            },
            prompt: {
              text: chineseTask(messages)
                ? `后台命令 ${id} 已结束，属于原任务 ${job.metadata?.sourceMessageID ?? id}。这是宿主完成通知，保留原任务要求和授权。完成通知身份：${id}_completed。以下为退出状态及日志尾部，不代表整项任务成功；需要全文或验证结果时用 bash_job get，不要重新执行原命令。\n${result}\n${tail}`
                : `Background command ${id} ended for task ${job.metadata?.sourceMessageID ?? id}. This is a host observation; preserve the original requirements and authorization. Completion identity: ${id}_completed. The exit status and log tail below do not establish overall task success. Use bash_job get for the full result or verification; do not rerun the command.\n${result}\n${tail}`,
            },
          })
          watched.delete(id)
          notified.add(id)
          if (!stopped.has(record.sessionID))
            yield* events.publish(SessionExecution.Wake, { sessionID: record.sessionID })
        }).pipe(
          Effect.catchCause(() =>
            Effect.logError("Background completion notification admission failed", {
              jobID: id,
              notificationID: `${id}_completed`,
            }),
          ),
        ),
      )
    const results = new Map<
      string,
      {
        executionRecord?: SessionOutcome.ExecutionRecord
        verification?: SessionOutcome.Check
        verifications?: readonly SessionOutcome.Check[]
      }
    >()
    yield* Effect.addFinalizer(() => Effect.forEach(owned, (id) => jobs.cancel(id), { discard: true }))

    const start = (
      command: string,
      run: Effect.Effect<string, unknown>,
      context: Tool.Context,
      prepare: Effect.Effect<void, unknown>,
      background?: { kind: "task" | "preview"; workdir: string; observe?: ToolOutputStore.CaptureHandle["snapshot"] },
      onExisting?: Effect.Effect<void>,
    ) => {
      const id = `msg_bash_${context.assistantMessageID}_${context.toolCallID}`
      return locks.withLock(id)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const previous = yield* sessions.message(SessionMessage.ID.make(id))
            if (previous) {
              if (
                previous.sessionID !== context.sessionID ||
                previous.message.type !== "shell" ||
                previous.message.command !== command
              )
                return yield* new Tool.Failure({ message: "Conflicting background command retry" })
              if (onExisting) yield* onExisting
              return id
            }
            yield* prepare.pipe(Effect.mapError((error) => new Tool.Failure({ message: String(error) })))
            if (background?.observe) observations.set(id, background.observe)
            yield* events.publish(SessionEvent.Shell.Started, {
              sessionID: context.sessionID,
              messageID: SessionMessage.ID.make(id),
              callID: id,
              command,
              origin: "tool",
              timestamp: yield* DateTime.now,
            })
            const persistent =
              background?.kind === "preview" && AppProcess.supportsPersistentPreview(yield* AppProcess.PreviewPlatform)
            if (!persistent) owned.add(id)
            const source = requested(yield* history(database.db, context.sessionID)).sourceMessageID
            yield* jobs.start({
              id,
              detached: persistent,
              type: "bash",
              title: command,
              metadata: {
                sessionID: context.sessionID,
                sourceMessageID: source ?? context.assistantMessageID,
                directory: location.directory,
                workspaceID: location.workspaceID,
                kind: background?.kind ?? "task",
                workdir: background?.workdir ?? location.directory,
              },
              run: restore(run).pipe(
                Effect.onExit((exit) =>
                  Effect.gen(function* () {
                    const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
                    if (Exit.isFailure(exit) && !Cause.hasInterrupts(exit.cause))
                      yield* Effect.logError("Background command failed", {
                        jobID: id,
                        cause: Cause.pretty(exit.cause),
                      })
                    yield* events
                      .publish(SessionEvent.Shell.Ended, {
                        sessionID: context.sessionID,
                        callID: id,
                        output: Exit.isSuccess(exit)
                          ? exit.value
                          : Cause.hasInterrupts(exit.cause)
                            ? "Background command cancelled. Its effects may be partial; inspect the command log before retrying."
                            : failure instanceof CommandFailed
                              ? failure.output
                              : `Command failed (exit unknown${systemErrorCode(failure) ? `, ${systemErrorCode(failure)}` : ""}).\n${observations.get(id)?.().output.slice(-8192) || "(no output)"}`,
                        timestamp: DateTime.nowUnsafe(),
                        executionRecord: results.get(id)?.executionRecord,
                        checks:
                          results.get(id)?.verifications ??
                          (results.get(id)?.verification ? [results.get(id)!.verification!] : []),
                      })
                      .pipe(
                        Effect.andThen(
                          Effect.gen(function* () {
                            if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) {
                              watched.delete(id)
                              return
                            }
                            yield* notify(id)
                          }),
                        ),
                      )
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    owned.delete(id)
                  }),
                ),
              ),
            })
            return id
          }),
        ),
      )
    }

    yield* tools
      .register({
        bash_job: withPermission(
          Tool.make({
            observation: (input) => input.action === "get" || input.action === "wait",
            description:
              "Manage a background shell job: call bash_job with job_id and action get, wait, or cancel. wait blocks until the job finishes or timeout expires (default 600000 ms); it does not cancel the process. Use one blocking wait instead of polling unchanged output. A running job is not a failure and must not be restarted. Task completion records results and notifies once while the task is active; after a final answer it suppresses only results already read in that request. Services (preview) do not notify. Preview ownership persists across host restarts; other jobs are process-local. Unknown jobs are never rerun automatically.",
            input: Schema.Struct({
              job_id: Schema.String,
              action: Schema.Literals(["get", "wait", "cancel"]),
              timeout: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
            }),
            output: Schema.Struct({
              executionRecord: Schema.optional(SessionOutcome.ExecutionRecord),
              status: Schema.String,
              output: Schema.String,
              verification: Schema.optional(SessionOutcome.Check),
              verifications: Schema.optional(Schema.Array(SessionOutcome.Check)),
              kind: Schema.optional(Schema.String),
              workdir: Schema.optional(Schema.String),
              exit: Schema.optional(Schema.Number),
              cursor: Schema.optional(Schema.Number),
              truncated: Schema.optional(Schema.Boolean),
            }),
            structured: Schema.Struct({
              verification: Schema.optional(SessionOutcome.Check),
              verifications: Schema.optional(Schema.Array(SessionOutcome.Check)),
              executionRecord: Schema.optional(SessionOutcome.ExecutionRecord),
              status: Schema.String,
              kind: Schema.optional(Schema.String),
              workdir: Schema.optional(Schema.String),
              exit: Schema.optional(Schema.Number),
              cursor: Schema.optional(Schema.Number),
              truncated: Schema.optional(Schema.Boolean),
            }),
            toStructuredOutput: ({ output }) => ({
              executionRecord: output.executionRecord,
              status: output.status,
              kind: output.kind,
              workdir: output.workdir,
              ...(output.exit === undefined ? {} : { exit: output.exit }),
              ...(output.cursor === undefined ? {} : { cursor: output.cursor, truncated: output.truncated }),
              verification: output.verification,
              verifications: output.verifications,
            }),
            toModelOutput: ({ output }) => [
              {
                type: "text",
                text: `${output.status}${output.exit === undefined ? "" : ` (exit ${output.exit})`}${output.kind ? ` (${output.kind})` : ""}${output.workdir ? ` in ${output.workdir}` : ""}${output.cursor === undefined ? "" : ` [capture cursor=${output.cursor}${output.truncated ? "; tail only" : ""}]`}\n${output.output}`,
              },
            ],
            execute: (input, context) =>
              Effect.gen(function* () {
                const record = yield* sessions.message(SessionMessage.ID.make(input.job_id))
                if (
                  !record ||
                  record.sessionID !== context.sessionID ||
                  record.message.type !== "shell" ||
                  !input.job_id.startsWith("msg_bash_")
                )
                  return yield* new Tool.Failure({ message: "Background command not found in this Session" })
                const session = yield* sessions.get(context.sessionID)
                if (
                  session?.location.directory !== location.directory ||
                  session.location.workspaceID !== location.workspaceID
                )
                  return yield* new Tool.Failure({ message: "Background command belongs to another Location" })
                const job = yield* jobs.get(input.job_id)
                if (
                  job &&
                  (job.metadata?.sessionID !== context.sessionID ||
                    job.metadata.directory !== location.directory ||
                    job.metadata.workspaceID !== location.workspaceID)
                )
                  return yield* new Tool.Failure({ message: "Background command belongs to another owner" })
                yield* permissions
                  .assert({
                    action: "bash",
                    resources: [record.message.command],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                  .pipe(Effect.mapError((error) => new Tool.Failure({ message: error.message })))
                const bound =
                  input.action === "wait"
                    ? yield* SessionBudget.bounds(database.db, config, context.sessionID)
                    : undefined
                const closingAt = SessionBudget.closingDeadline(bound?.deadline, bound?.policy?.closingReserveMs)
                const now = yield* Clock.currentTimeMillis
                const remaining = closingAt === undefined ? undefined : closingAt - now
                if (remaining !== undefined && remaining <= 0)
                  return yield* new Tool.Failure({
                    message:
                      "The host deadline or closing reserve prevents an observation wait. get and cancel remain available.",
                  })
                const waitUntil = SessionBudget.observationDeadline(closingAt, now)
                const timeout =
                  waitUntil === undefined
                    ? (input.timeout ?? 600_000)
                    : Math.min(input.timeout ?? 600_000, Math.max(0, waitUntil - now))
                if (!job) {
                  const owner = {
                    root: global.data,
                    jobID: input.job_id,
                    sessionID: context.sessionID,
                    directory: location.directory,
                    workspaceID: location.workspaceID,
                  }
                  const preview = yield* Effect.tryPromise(() =>
                    input.action === "cancel" ? PreviewProcess.cancel(owner) : PreviewProcess.get(owner),
                  ).pipe(Effect.mapError((cause) => new Tool.Failure({ message: String(cause) })))
                  if (preview) {
                    const completed = record.message.time.completed
                    const report = (state: NonNullable<Awaited<ReturnType<typeof PreviewProcess.get>>>) =>
                      Effect.gen(function* () {
                        if (state.status !== "running" && state.status !== "unavailable" && !completed)
                          yield* events.publish(SessionEvent.Shell.Ended, {
                            sessionID: context.sessionID,
                            callID: input.job_id,
                            output: `${state.status}: ${state.output}`,
                            timestamp: yield* DateTime.now,
                          })
                        return { status: state.status, kind: "preview", output: state.output }
                      })
                    if (input.action === "wait") {
                      const deadline = (yield* Clock.currentTimeMillis) + timeout
                      while (preview.status === "running" && (yield* Clock.currentTimeMillis) < deadline) {
                        yield* Effect.sleep(Math.max(1, Math.min(250, deadline - (yield* Clock.currentTimeMillis))))
                        const current = yield* Effect.tryPromise(() => PreviewProcess.get(owner)).pipe(
                          Effect.mapError((cause) => new Tool.Failure({ message: String(cause) })),
                        )
                        if (!current) return { status: "unavailable", kind: "preview", output: preview.output }
                        if (current.status !== "running") return yield* report(current)
                      }
                    }
                    return yield* report(preview)
                  }
                  return {
                    status: record.message.time.completed ? "finished" : "unavailable",
                    executionRecord: record.message.executionRecord,
                    verifications: record.message.checks,
                    output:
                      record.message.output ||
                      "The owning process is unavailable. Do not assume completion or retry automatically; inspect the command log and workspace.",
                  }
                }
                const result =
                  input.action === "cancel"
                    ? yield* jobs.cancel(input.job_id)
                    : input.action === "wait"
                      ? (yield* jobs.wait({ id: input.job_id, timeout })).info
                      : job
                const evidence = result && result.status !== "running" ? results.get(input.job_id) : undefined
                const observation = observations.get(input.job_id)?.()
                const failed =
                  result?.status === "error" ? yield* sessions.message(SessionMessage.ID.make(input.job_id)) : undefined
                return {
                  executionRecord: evidence?.executionRecord,
                  ...(evidence?.verification ? { verification: evidence.verification } : {}),
                  ...(evidence?.verifications
                    ? {
                        verifications: evidence.verifications.map((check) => ({
                          ...check,
                          callID: check.callID,
                        })),
                      }
                    : {}),
                  status: result?.status ?? "unavailable",
                  ...(evidence?.executionRecord?.exit === undefined ? {} : { exit: evidence.executionRecord.exit }),
                  ...(observation ? { cursor: observation.cursor, truncated: observation.truncated } : {}),
                  kind: typeof result?.metadata?.kind === "string" ? result.metadata.kind : undefined,
                  workdir: typeof result?.metadata?.workdir === "string" ? result.metadata.workdir : undefined,
                  output:
                    result?.status === "error"
                      ? failed?.message.type === "shell"
                        ? failed.message.output
                        : "Background command failed. Inspect internal diagnostics."
                      : (result?.output ??
                        result?.error ??
                        observation?.output ??
                        "Still running. Read the command log or wait for completion."),
                }
              }),
          }),
          "bash",
        ),
      })
      .pipe(Effect.orDie)
    return Service.of({
      start,
      watch: (id) =>
        Effect.sync(() => {
          watched.add(id)
        }).pipe(Effect.andThen(notify(id))),
      record: (id, result) =>
        Effect.sync(() => {
          results.set(id, result)
        }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Location.node,
    BackgroundJob.node,
    EventV2.node,
    SessionStore.node,
    PermissionV2.node,
    ToolRegistry.node,
    Database.node,
    Config.node,
    Global.node,
  ],
})
