import { describe, expect } from "bun:test"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { ModelV2 } from "@zaovra-ai/core/model"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionInput } from "@zaovra-ai/core/session/input"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { TaskTool } from "@zaovra-ai/core/tool/task"
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

const assertions: PermissionV2.AssertInput[] = []
const permission = Layer.mock(PermissionV2.Service, {
  assert: (input) => Effect.sync(() => assertions.push(input)),
})
const it = testEffect(Layer.mergeAll(AgentV2.locationLayer, permission))
const parentID = SessionV2.ID.make("ses_task_parent")
const childID = SessionV2.ID.make("ses_task_child")
const location = { directory: AbsolutePath.make("/project") }

describe("TaskTool", () => {
  it.effect("runs a permitted subagent in an independent child Session", () =>
    Effect.gen(function* () {
      assertions.length = 0
      yield* registerExplore()
      const creates: Array<{ readonly id?: SessionV2.ID }> = []
      const prompts: Array<{
        readonly id: SessionMessage.ID | undefined
        readonly sessionID: SessionV2.ID
        readonly text: string
      }> = []
      const sessions = sessionOps({
        create: (input) =>
          Effect.sync(() => (creates.push(input), info(childID, parentID, AgentV2.ID.make("explore")))),
        prompt: (input) =>
          Effect.sync(() => prompts.push({ id: input.id, sessionID: input.sessionID, text: input.prompt.text })).pipe(
            Effect.as(admitted(input.sessionID, input.prompt.text)),
          ),
      })

      expect(
        yield* TaskTool.run(
          sessions,
          info(parentID),
          { description: "Inspect code", prompt: "Find the state machine", subagent_type: "explore" },
          { sessionID: parentID, ...toolIdentity, toolCallID: "call-task" },
        ),
      ).toEqual({ task_id: childID, content: "The state machine is durable." })
      expect(creates).toMatchObject([{ id: "ses_task_ses_task_parent_msg_tool_test_call-task" }])
      expect(prompts).toEqual([
        {
          id: SessionMessage.ID.make("msg_task_ses_task_parent_msg_tool_test_call-task"),
          sessionID: childID,
          text: "Find the state machine",
        },
      ])
      expect(assertions).toMatchObject([
        {
          sessionID: parentID,
          action: "task",
          resources: ["explore"],
          source: { type: "tool", callID: "call-task" },
        },
      ])
    }),
  )

  it.effect("rejects nested and foreign child Sessions", () =>
    Effect.gen(function* () {
      yield* registerExplore()
      const nested = yield* TaskTool.run(
        sessionOps(),
        info(parentID, SessionV2.ID.make("ses_grandparent")),
        { description: "Nested", prompt: "Delegate again", subagent_type: "explore" },
        { sessionID: parentID, ...toolIdentity, toolCallID: "call-nested" },
      ).pipe(Effect.exit)
      expect(nested).toMatchObject({ _tag: "Failure" })

      const foreign = yield* TaskTool.run(
        sessionOps({ child: info(childID, SessionV2.ID.make("ses_other_parent"), AgentV2.ID.make("explore")) }),
        info(parentID),
        { description: "Resume", prompt: "Continue", subagent_type: "explore", task_id: childID },
        { sessionID: parentID, ...toolIdentity, toolCallID: "call-foreign" },
      ).pipe(Effect.exit)
      expect(foreign).toMatchObject({ _tag: "Failure" })
    }),
  )

  it.effect("interrupts the child Session when the parent tool call is cancelled", () =>
    Effect.gen(function* () {
      yield* registerExplore()
      const started = yield* Deferred.make<void>()
      const interrupted: SessionV2.ID[] = []
      const sessions = sessionOps({
        resume: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        interrupt: (sessionID) => Effect.sync(() => interrupted.push(sessionID)),
      })
      const fiber = yield* TaskTool.run(
        sessions,
        info(parentID),
        { description: "Wait", prompt: "Long task", subagent_type: "explore" },
        { sessionID: parentID, ...toolIdentity, toolCallID: "call-cancel" },
      ).pipe(Effect.forkScoped)

      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)

      expect(interrupted).toEqual([childID])
    }),
  )

  it.effect("admits a background subagent without joining its execution", () =>
    Effect.gen(function* () {
      yield* registerExplore()
      const admissions: Array<{ readonly resume?: boolean }> = []
      let resumes = 0
      const sessions = sessionOps({
        prompt: (input) =>
          Effect.sync(() => admissions.push({ resume: input.resume })).pipe(
            Effect.as(admitted(input.sessionID, input.prompt.text)),
          ),
        resume: () => Effect.sync(() => resumes++),
      })

      expect(
        yield* TaskTool.run(
          sessions,
          info(parentID),
          {
            description: "Inspect asynchronously",
            prompt: "Map the runtime",
            subagent_type: "explore",
            run_in_background: true,
          },
          { sessionID: parentID, ...toolIdentity, toolCallID: "call-background" },
        ),
      ).toMatchObject({ task_id: childID, content: expect.stringContaining("task_status") })
      expect(admissions).toEqual([{ resume: true }])
      expect(resumes).toBe(0)
    }),
  )

  it.effect("reports a durably queued child without starting it", () =>
    Effect.gen(function* () {
      yield* registerExplore()
      const sessions = sessionOps({ pending: () => Effect.succeed(true) })

      expect(
        yield* TaskTool.status(sessions, info(parentID), childID, {
          sessionID: parentID,
          ...toolIdentity,
          toolCallID: "call-status",
        }),
      ).toEqual({ task_id: childID, status: "queued" })
    }),
  )
})

function registerExplore() {
  return AgentV2.Service.use((agents) =>
    agents.transform((draft) =>
      draft.update(AgentV2.ID.make("explore"), (agent) => {
        agent.mode = "subagent"
      }),
    ),
  )
}

function sessionOps(overrides?: {
  readonly child?: SessionV2.Info
  readonly create?: Pick<SessionV2.Interface, "create">["create"]
  readonly prompt?: Pick<SessionV2.Interface, "prompt">["prompt"]
  readonly resume?: Pick<SessionV2.Interface, "resume">["resume"]
  readonly interrupt?: Pick<SessionV2.Interface, "interrupt">["interrupt"]
  readonly pending?: Pick<SessionV2.Interface, "pending">["pending"]
}): Pick<
  SessionV2.Interface,
  "list" | "get" | "create" | "prompt" | "pending" | "resume" | "interrupt" | "active" | "messages"
> {
  const child = overrides?.child ?? info(childID, parentID, AgentV2.ID.make("explore"))
  return {
    list: () => Effect.succeed([info(parentID), child]),
    get: (sessionID) => (sessionID === child.id ? Effect.succeed(child) : Effect.succeed(info(parentID))),
    create: overrides?.create ?? (() => Effect.succeed(child)),
    prompt: overrides?.prompt ?? ((input) => Effect.succeed(admitted(input.sessionID, input.prompt.text))),
    resume: overrides?.resume ?? (() => Effect.void),
    interrupt: overrides?.interrupt ?? (() => Effect.void),
    pending: overrides?.pending ?? (() => Effect.succeed(false)),
    active: Effect.succeed(new Set()),
    messages: () => Effect.succeed([assistant(child.agent ?? AgentV2.ID.make("explore"))]),
  }
}

function info(id: SessionV2.ID, parentID?: SessionV2.ID, agent?: AgentV2.ID) {
  return SessionV2.Info.make({
    id,
    parentID,
    projectID: ProjectV2.ID.global,
    agent,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
    title: "Task Session",
    location,
  })
}

function admitted(sessionID: SessionV2.ID, text: string) {
  return SessionInput.Admitted.make({
    admittedSeq: 1,
    id: SessionMessage.ID.create(),
    sessionID,
    prompt: { text },
    delivery: "steer",
    timeCreated: DateTime.makeUnsafe(1),
  })
}

function assistant(agent: AgentV2.ID) {
  return SessionMessage.Assistant.make({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent,
    model: ModelV2.Ref.make({ id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") }),
    content: [{ type: "text", id: "text", text: "The state machine is durable." }],
    time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
  })
}
