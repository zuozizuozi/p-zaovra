export * as TaskTool from "./task"

import { ToolFailure } from "@zaovra-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeGlobalNode } from "../effect/app-node"
import { LocationServiceMap } from "../location-service-map"
import { PermissionV2 } from "../permission"
import { SessionV2 } from "../session"
import { SessionMessage } from "../session/message"
import { ApplicationTools } from "./application-tools"
import { Tool } from "./tool"

export const name = "task"
export const statusName = "task_status"
export const listName = "task_list"
export const cancelName = "task_cancel"
export const resumeName = "task_resume"

export const description = `Delegate one focused task to an independent subagent Session and wait for its result.

Fresh calls receive only the supplied prompt, not the parent conversation. Reuse task_id to continue the same child Session. Subagents cannot create nested subagents.`

export const Input = Schema.Struct({
  description: Schema.String.annotate({ description: "Short description of the delegated task" }),
  prompt: Schema.String.annotate({ description: "Complete instructions and context for the subagent" }),
  subagent_type: Schema.String.annotate({ description: "Configured subagent role, such as explore or general" }),
  task_id: SessionV2.ID.pipe(Schema.optional).annotate({
    description: "Existing child Session ID to continue instead of creating a fresh subagent",
  }),
  run_in_background: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Admit and start the child Session without waiting for its final response",
  }),
})

export const Output = Schema.Struct({
  task_id: SessionV2.ID,
  content: Schema.String,
})

export const Status = Schema.Literals(["idle", "queued", "running", "completed", "failed", "unknown"])
export type Status = typeof Status.Type

export const StatusInput = Schema.Struct({ task_id: SessionV2.ID })
export const StatusOutput = Schema.Struct({
  task_id: SessionV2.ID,
  status: Status,
  content: Schema.String.pipe(Schema.optional),
})
export const ListOutput = Schema.Struct({ tasks: Schema.Array(StatusOutput) })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* SessionV2.Service

    yield* applications
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) => [
            {
              type: "text",
              text: input.run_in_background
                ? `Subagent @${input.subagent_type} started in background. task_id=${output.task_id}\n\n${output.content}`
                : `Subagent @${input.subagent_type} completed. task_id=${output.task_id}\n\n${output.content}`,
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(Effect.mapError(() => failure(`Parent Session not found: ${context.sessionID}`)))
              return yield* run(sessions, parent, input, context).pipe(Effect.provide(locations.get(parent.location)))
            }),
        }),
        [statusName]: Tool.make({
          description: "Inspect one child subagent Session without restarting it.",
          input: StatusInput,
          output: StatusOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(Effect.mapError(() => failure(`Parent Session not found: ${context.sessionID}`)))
              return yield* status(sessions, parent, input.task_id, context).pipe(
                Effect.provide(locations.get(parent.location)),
              )
            }),
        }),
        [listName]: Tool.make({
          description: "List child subagent Sessions owned by the current parent Session.",
          input: Schema.Struct({}),
          output: ListOutput,
          execute: (_input, context) =>
            Effect.gen(function* () {
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(Effect.mapError(() => failure(`Parent Session not found: ${context.sessionID}`)))
              return yield* list(sessions, parent, context).pipe(Effect.provide(locations.get(parent.location)))
            }),
        }),
        [cancelName]: Tool.make({
          description: "Interrupt one running child subagent Session owned by the current parent Session.",
          input: StatusInput,
          output: StatusOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(Effect.mapError(() => failure(`Parent Session not found: ${context.sessionID}`)))
              return yield* cancel(sessions, parent, input.task_id, context).pipe(
                Effect.provide(locations.get(parent.location)),
              )
            }),
        }),
        [resumeName]: Tool.make({
          description:
            "Explicitly resume a child subagent Session after an interrupted or unknown execution and wait for it.",
          input: StatusInput,
          output: StatusOutput,
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* sessions
                .get(context.sessionID)
                .pipe(Effect.mapError(() => failure(`Parent Session not found: ${context.sessionID}`)))
              return yield* resume(sessions, parent, input.task_id, context).pipe(
                Effect.provide(locations.get(parent.location)),
              )
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

type SessionOps = Pick<
  SessionV2.Interface,
  "list" | "get" | "create" | "prompt" | "pending" | "resume" | "interrupt" | "active" | "messages"
>

export const run = Effect.fn("TaskTool.execute")(function* (
  sessions: SessionOps,
  parent: SessionV2.Info,
  input: typeof Input.Type,
  context: Tool.Context,
) {
  const agents = yield* AgentV2.Service
  const permission = yield* PermissionV2.Service
  if (parent.parentID)
    return yield* failure("Subagents cannot delegate nested tasks; return the finding to the parent Agent")
  const targetID = AgentV2.ID.make(input.subagent_type)
  const target = yield* agents.get(targetID)
  if (!target || target.mode !== "subagent")
    return yield* failure(`Unknown or unavailable subagent type: ${input.subagent_type}`)

  yield* permission
    .assert({
      action: "task",
      resources: [input.subagent_type],
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
    })
    .pipe(Effect.mapError(() => failure(`Permission denied: task ${input.subagent_type}`)))

  const child = input.task_id
    ? yield* sessions
        .get(input.task_id)
        .pipe(Effect.mapError(() => failure(`Subagent Session not found: ${input.task_id}`)))
    : yield* sessions.create({
        id: SessionV2.ID.make(`ses_task_${parent.id}_${context.assistantMessageID}_${context.toolCallID}`),
        location: parent.location,
        parentID: parent.id,
        agent: targetID,
      })
  if (child.parentID !== parent.id)
    return yield* failure(`Subagent Session ${child.id} does not belong to parent ${parent.id}`)
  if (child.agent !== targetID)
    return yield* failure(`Subagent Session ${child.id} is not owned by @${input.subagent_type}`)

  const admission = sessions
    .prompt({
      id: SessionMessage.ID.make(`msg_task_${parent.id}_${context.assistantMessageID}_${context.toolCallID}`),
      sessionID: child.id,
      prompt: { text: input.prompt },
      resume: input.run_in_background === true,
    })
    .pipe(Effect.mapError((error) => failure(error instanceof Error ? error.message : String(error))))
  if (input.run_in_background) {
    yield* admission
    return { task_id: child.id, content: "Use task_status to inspect progress or task_cancel to interrupt it." }
  }
  yield* admission.pipe(
    Effect.andThen(sessions.resume(child.id).pipe(Effect.onInterrupt(() => sessions.interrupt(child.id)))),
    Effect.mapError((error) => failure(error instanceof Error ? error.message : String(error))),
  )
  const messages = yield* sessions
    .messages({ sessionID: child.id, order: "desc", limit: 50 })
    .pipe(Effect.mapError((error) => failure(error instanceof Error ? error.message : String(error))))
  const response = messages.find((message) => message.type === "assistant")
  if (!response || response.type !== "assistant")
    return yield* failure(`Subagent Session ${child.id} produced no assistant response`)
  if (response.error) return yield* failure(response.error.message)
  const content = response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  return { task_id: child.id, content: content || "Subagent completed without a textual response." }
})

export const status = Effect.fn("TaskTool.status")(function* (
  sessions: SessionOps,
  parent: SessionV2.Info,
  taskID: SessionV2.ID,
  context: Tool.Context,
) {
  const child = yield* requireChild(sessions, parent, taskID)
  yield* authorize(child, context)
  return yield* inspect(sessions, child)
})

export const list = Effect.fn("TaskTool.list")(function* (
  sessions: SessionOps,
  parent: SessionV2.Info,
  context: Tool.Context,
) {
  if (parent.parentID) return yield* failure("Subagents cannot manage nested tasks")
  const children = (yield* sessions.list()).filter((session) => session.parentID === parent.id)
  yield* Effect.forEach(children, (child) => authorize(child, context), { discard: true })
  return { tasks: yield* Effect.forEach(children, (child) => inspect(sessions, child)) }
})

export const cancel = Effect.fn("TaskTool.cancel")(function* (
  sessions: SessionOps,
  parent: SessionV2.Info,
  taskID: SessionV2.ID,
  context: Tool.Context,
) {
  const child = yield* requireChild(sessions, parent, taskID)
  yield* authorize(child, context)
  yield* sessions.interrupt(child.id)
  return yield* inspect(sessions, child)
})

export const resume = Effect.fn("TaskTool.resume")(function* (
  sessions: SessionOps,
  parent: SessionV2.Info,
  taskID: SessionV2.ID,
  context: Tool.Context,
) {
  const child = yield* requireChild(sessions, parent, taskID)
  yield* authorize(child, context)
  yield* sessions
    .resume(child.id)
    .pipe(Effect.mapError((error) => failure(error instanceof Error ? error.message : String(error))))
  return yield* inspect(sessions, child)
})

const inspect = Effect.fnUntraced(function* (sessions: SessionOps, child: SessionV2.Info) {
  if ((yield* sessions.active).has(child.id)) return { task_id: child.id, status: "running" as const }
  if (
    yield* sessions
      .pending(child.id)
      .pipe(Effect.mapError((error) => failure(error instanceof Error ? error.message : String(error))))
  )
    return { task_id: child.id, status: "queued" as const }
  const messages = yield* sessions
    .messages({ sessionID: child.id, order: "desc", limit: 50 })
    .pipe(Effect.mapError((error) => failure(error instanceof Error ? error.message : String(error))))
  const latest = messages.find((message) => message.type === "assistant" || message.type === "user")
  if (!latest) return { task_id: child.id, status: "idle" as const }
  if (latest.type === "user") return { task_id: child.id, status: "unknown" as const }
  const content = latest.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  return latest.error
    ? { task_id: child.id, status: "failed" as const, content: latest.error.message }
    : { task_id: child.id, status: "completed" as const, ...(content ? { content } : {}) }
})

const requireChild = Effect.fnUntraced(function* (sessions: SessionOps, parent: SessionV2.Info, taskID: SessionV2.ID) {
  if (parent.parentID) return yield* failure("Subagents cannot manage nested tasks")
  const child = yield* sessions
    .get(taskID)
    .pipe(Effect.mapError(() => failure(`Subagent Session not found: ${taskID}`)))
  if (child.parentID !== parent.id)
    return yield* failure(`Subagent Session ${child.id} does not belong to parent ${parent.id}`)
  return child
})

const authorize = Effect.fnUntraced(function* (child: SessionV2.Info, context: Tool.Context) {
  const permission = yield* PermissionV2.Service
  yield* permission
    .assert({
      action: "task",
      resources: [child.agent ?? child.id],
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
    })
    .pipe(Effect.mapError(() => failure(`Permission denied: task ${child.id}`)))
})

function failure(message: string) {
  return new ToolFailure({ message })
}

export const node = makeGlobalNode({
  name: "tool/task",
  layer,
  deps: [ApplicationTools.node, LocationServiceMap.node, SessionV2.node],
})
