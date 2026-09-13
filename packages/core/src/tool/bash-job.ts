export * as BashJob from "./bash-job"

import { Cause, Context, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { BackgroundJob } from "../background-job"
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

export class Service extends Context.Service<
  Service,
  {
    readonly start: (
      command: string,
      run: Effect.Effect<string, unknown>,
      context: Tool.Context,
      prepare: Effect.Effect<void, unknown>,
    ) => Effect.Effect<string, Tool.Failure>
  }
>()("@zaovra/BashJob") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const events = yield* EventV2.Service
    const sessions = yield* SessionStore.Service
    const location = yield* Location.Service
    const permissions = yield* PermissionV2.Service
    const tools = yield* Tools.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const owned = new Set<string>()
    yield* Effect.addFinalizer(() => Effect.forEach(owned, (id) => jobs.cancel(id), { discard: true }))

    const start = (
      command: string,
      run: Effect.Effect<string, unknown>,
      context: Tool.Context,
      prepare: Effect.Effect<void, unknown>,
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
              return id
            }
            yield* prepare.pipe(Effect.mapError((error) => new Tool.Failure({ message: String(error) })))
            yield* events.publish(SessionEvent.Shell.Started, {
              sessionID: context.sessionID,
              messageID: SessionMessage.ID.make(id),
              callID: id,
              command,
              timestamp: yield* DateTime.now,
            })
            owned.add(id)
            yield* jobs.start({
              id,
              type: "bash",
              title: command,
              metadata: {
                sessionID: context.sessionID,
                directory: location.directory,
                workspaceID: location.workspaceID,
              },
              run: restore(run).pipe(
                Effect.onExit((exit) =>
                  events.publish(SessionEvent.Shell.Ended, {
                    sessionID: context.sessionID,
                    callID: id,
                    output: Exit.isSuccess(exit)
                      ? exit.value
                      : Cause.hasInterrupts(exit.cause)
                        ? "Background command cancelled. Its effects may be partial; inspect the command log before retrying."
                        : `Background command failed: ${Cause.pretty(exit.cause)}`,
                    timestamp: DateTime.nowUnsafe(),
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
            description:
              "Inspect, wait for, or cancel a background Bash command owned by this Session and Location. Waiting is bounded and does not cancel the command. Completion is recorded in Session history; use wait to collect the result. Jobs are process-local and never automatically rerun after restart.",
            input: Schema.Struct({
              job_id: Schema.String,
              action: Schema.Literals(["get", "wait", "cancel"]),
              timeout: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 60_000 })).pipe(Schema.optional),
            }),
            output: Schema.Struct({ status: Schema.String, output: Schema.String }),
            structured: Schema.Struct({ status: Schema.String }),
            toStructuredOutput: ({ output }) => ({ status: output.status }),
            toModelOutput: ({ output }) => [{ type: "text", text: `${output.status}\n${output.output}` }],
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
                if (!job)
                  return {
                    status: record.message.time.completed ? "finished" : "unavailable",
                    output:
                      record.message.output ||
                      "The owning process is unavailable. Do not assume completion or retry automatically; inspect the command log and workspace.",
                  }
                const result =
                  input.action === "cancel"
                    ? yield* jobs.cancel(input.job_id)
                    : input.action === "wait"
                      ? (yield* jobs.wait({ id: input.job_id, timeout: input.timeout ?? 30_000 })).info
                      : job
                return {
                  status: result?.status ?? "unavailable",
                  output:
                    result?.output ?? result?.error ?? "Still running. Read the command log or wait for completion.",
                }
              }),
          }),
          "bash",
        ),
      })
      .pipe(Effect.orDie)
    return Service.of({ start })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node, BackgroundJob.node, EventV2.node, SessionStore.node, PermissionV2.node, ToolRegistry.node],
})
