import { describe, expect } from "bun:test"
import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  TransportReason,
  InvalidRequestReason,
  type LLMClientShape,
  type LLMRequest,
} from "@zaovra-ai/llm"
import { Auth } from "@zaovra-ai/llm/route"
import { fixedResponse } from "../../llm/test/lib/http"
import { sseEvents } from "../../llm/test/lib/sse"
import { deltaChunk, usageChunk } from "../../llm/test/lib/openai-chunks"
import * as OpenAIChat from "@zaovra-ai/llm/protocols/openai-chat"
import { Database } from "@zaovra-ai/core/database/database"
import { makeLocationNode } from "@zaovra-ai/core/effect/app-node"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@zaovra-ai/core/effect/app-node-platform"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { EventTable } from "@zaovra-ai/core/event/sql"
import { Project } from "@zaovra-ai/core/project"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { QuestionV2 } from "@zaovra-ai/core/question"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { Snapshot } from "@zaovra-ai/core/snapshot"
import { ContextSnapshotDecodeError } from "@zaovra-ai/core/session/error"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { SessionInput } from "@zaovra-ai/core/session/input"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionOutcome } from "@zaovra-ai/core/session/outcome"
import { SessionOutputRecovery } from "@zaovra-ai/core/session/output-recovery"
import { SessionUsageQuery } from "@zaovra-ai/core/session/usage"
import { Prompt } from "@zaovra-ai/core/session/prompt"
import { SessionProjector } from "@zaovra-ai/core/session/projector"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionRunCoordinator } from "@zaovra-ai/core/session/run-coordinator"
import { SessionRunner } from "@zaovra-ai/core/session/runner"
import * as SessionRunnerLLM from "@zaovra-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@zaovra-ai/core/session/runner/model"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { ApplicationTools } from "@zaovra-ai/core/tool/application-tools"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { Config } from "@zaovra-ai/core/config"
import { ConfigCompaction } from "@zaovra-ai/core/config/compaction"
import { Tool } from "@zaovra-ai/core/tool/tool"
import { TaskTool } from "@zaovra-ai/core/tool/task"
import { VerificationReviewTool } from "@zaovra-ai/core/tool/verification-review"
import { CommandV2 } from "@zaovra-ai/core/command"
import {
  SessionContextEpochTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@zaovra-ai/core/session/sql"
import { SessionStore } from "@zaovra-ai/core/session/store"
import { SystemContext } from "@zaovra-ai/core/system-context"
import { SystemContextRegistry } from "@zaovra-ai/core/system-context/registry"
import { SkillGuidance } from "@zaovra-ai/core/skill/guidance"
import { ReferenceGuidance } from "@zaovra-ai/core/reference/guidance"
import { ModelV2 } from "@zaovra-ai/core/model"
import { Location } from "@zaovra-ai/core/location"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { PluginV2 } from "@zaovra-ai/core/plugin"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

// Context epoch assertions exclude the separately checked per-request baseline.
function privilegedTexts(request: LLMRequest | undefined) {
  if (!request) return
  const parts = request.system.map((part) => part.text)
  const identity = parts.find((part) => part.startsWith("Provider: "))
  if (identity) {
    expect(identity).toContain(`Provider: ${request.model.provider}; model: ${request.model.id}.`)
    expect(identity).toContain("not proof of successful verification")
  }
  return parts.filter(
    (part) =>
      !part.startsWith("Provider: ") &&
      !part.startsWith("Verification rules:") &&
      !part.startsWith("When several reads or checks are independent,") &&
      !part.startsWith("You are a coding assistant. Inspect relevant context,"),
  )
}

const requests: LLMRequest[] = []
let response: LLMEvent[] = []
let responses: LLMEvent[][] | undefined
let responseStream: Stream.Stream<LLMEvent, LLMError> | undefined
let streamGate: Deferred.Deferred<void> | undefined
let streamStarted: Deferred.Deferred<void> | undefined
let streamFailure: LLMError | undefined
let toolExecutionGate: Deferred.Deferred<void> | undefined
let toolExecutionsStarted: Deferred.Deferred<void> | undefined
let toolExecutionsReady = 5
let activeToolExecutions = 0
let maxActiveToolExecutions = 0
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      if (responseStream) {
        const stream = responseStream
        responseStream = undefined
        return stream
      }
      const events = streamFailure
        ? Stream.fail(streamFailure)
        : Stream.fromIterable(responses === undefined ? response : (responses.shift() ?? []))
      if (!streamGate) return events
      return Stream.unwrap(
        (streamStarted ? Deferred.succeed(streamStarted, undefined) : Effect.void).pipe(
          Effect.andThen(Deferred.await(streamGate)),
          Effect.as(events),
        ),
      )
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const replacementModel = Model.make({ id: "replacement", provider: "fake", route: OpenAIChat.route })
const handoff = (objective: string) => `## Objective
- ${objective}
## Important Details
- Preserve the user constraints
## Work State
### Completed
- Earlier answer recorded, not independent verification
### Active
- Continue the existing request
### Blocked
- (none)
## Next Move
1. Inspect current files before continuing
## Relevant Files
- (none)`
const compactModel = Model.make({
  id: "compact",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 5_000, output: 50 } }),
})
const recoveryModel = Model.make({
  id: "recovery",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
})
const authorizations: Tool.Context[] = []
const executions: string[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, context) =>
          Effect.gen(function* () {
            authorizations.push(context)
            executions.push(text)
            activeToolExecutions++
            maxActiveToolExecutions = Math.max(maxActiveToolExecutions, activeToolExecutions)
            if (activeToolExecutions === toolExecutionsReady && toolExecutionsStarted) {
              yield* Deferred.succeed(toolExecutionsStarted, undefined)
            }
            if (toolExecutionGate) yield* Deferred.await(toolExecutionGate)
            return { text }
          }).pipe(Effect.ensuring(Effect.sync(() => activeToolExecutions--))),
      }),
      defect: Tool.make({
        description: "Fail unexpectedly",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () => Effect.die("unexpected tool defect"),
      }),
    }),
  ),
)
const echoNode = makeLocationNode({ name: "test/session-runner-tools", layer: echo, deps: [ToolRegistry.node] })
let modelResolveHook = Effect.void
let currentModel = model
const models = SessionRunnerModel.layerWith((session) =>
  modelResolveHook.pipe(Effect.as(session.model?.id === "replacement" ? replacementModel : currentModel)),
)
const systemContextKey = SystemContext.Key.make("test/context")
let systemBaseline = "Initial context"
let systemRemoved = false
let systemUnavailable = false
let systemLoadHook = Effect.void
const skillBaselines = new Map<AgentV2.ID, string>()
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.sync(() =>
          SystemContext.combine(
            systemRemoved
              ? []
              : [
                  SystemContext.make({
                    key: systemContextKey,
                    codec: Schema.toCodecJson(Schema.String),
                    load: systemLoadHook.pipe(
                      Effect.andThen(
                        Effect.sync(() => (systemUnavailable ? SystemContext.unavailable : systemBaseline)),
                      ),
                    ),
                    baseline: String,
                    update: (_previous, current) => current,
                    removed: () => "System context source removed: test/context",
                  }),
                ],
          ),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: (agent) =>
    Effect.succeed(
      skillBaselines.has(agent.id)
        ? SystemContext.make({
            key: SystemContext.Key.make("test/skill-guidance"),
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed(skillBaselines.get(agent.id)!),
            baseline: String,
            update: (_previous, current) => current,
            removed: () => "Skill guidance removed",
          })
        : SystemContext.empty,
    ),
})
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
let sessionTokenBudget: number | undefined
let sessionOutput: Config.Info["session_output"]
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            session_token_budget: sessionTokenBudget,
            session_output: sessionOutput,
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)
const plugins = Layer.succeed(
  PluginV2.Service,
  PluginV2.Service.of({
    add: () => Effect.void,
    remove: () => Effect.void,
    wait: () => Effect.void,
  }),
)
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [PluginV2.node, plugins],
  [Config.node, config],
])
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      exclusive: coordinator.exclusive,
      wait: coordinator.wait,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      echoNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [PluginV2.node, plugins],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_runner_test")
const otherSessionID = SessionV2.ID.make("ses_runner_other")

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  response = []
  sessionTokenBudget = undefined
  sessionOutput = undefined
  systemBaseline = "Initial context"
  systemRemoved = false
  systemUnavailable = false
  systemLoadHook = Effect.void
  modelResolveHook = Effect.void
  currentModel = model
  skillBaselines.clear()
  responses = undefined
  streamFailure = undefined
  responseStream = undefined
  streamGate = undefined
  streamStarted = undefined
  toolExecutionGate = undefined
  toolExecutionsStarted = undefined
  toolExecutionsReady = 5
  activeToolExecutions = 0
  maxActiveToolExecutions = 0
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

const providerUnavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "Provider unavailable" }),
  })

const setupOverflowRecovery = Effect.gen(function* () {
  yield* setup
  const session = yield* SessionV2.Service
  response = fragmentFixture("text", "text-earlier", ["Earlier answer"]).completeEvents
  yield* session.prompt({
    sessionID,
    prompt: Prompt.make({ text: "Earlier question ".repeat(700) }),
    resume: false,
  })
  yield* session.resume(sessionID)
  currentModel = recoveryModel
  requests.length = 0
  return session
})

const messageTexts = (request: LLMRequest, role: "user" | "system") =>
  request.messages.flatMap((message) =>
    message.role === role ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )
const userTexts = (request: LLMRequest) => messageTexts(request, "user")
const systemTexts = (request: LLMRequest) => messageTexts(request, "system")

// Reproduces the finish/usage shape of both Pixel Courier empty-directory failures.
const reasoningLimitResponse = (): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.reasoningStart({ id: "exhausted" }),
  LLMEvent.reasoningDelta({ id: "exhausted", text: "Planning the implementation" }),
  LLMEvent.reasoningEnd({ id: "exhausted" }),
  LLMEvent.stepFinish({
    index: 0,
    reason: "length",
    usage: { inputTokens: 100, nonCachedInputTokens: 100, outputTokens: 16384, reasoningTokens: 16384 },
  }),
  LLMEvent.finish({ reason: "length" }),
]

const replaySessionProjection = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)

    yield* events.remove(id)
    yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* events.replayAll(
      recorded.map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
    )
  })

type FragmentKind = "text" | "reasoning" | "tool input"

type FragmentFixture = {
  readonly delta: EventV2.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedAssistant: unknown
  readonly expectedContent: unknown
}

const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

const fragmentID = (kind: FragmentKind, suffix: string) => `${kind === "tool input" ? "call" : kind}-${suffix}`

const fragmentFixture = (kind: FragmentKind, id: string, chunks: readonly string[]): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
      ]
      const expectedContent = { type: "text", id, text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((text) => LLMEvent.reasoningDelta({ id, text })),
      ]
      const expectedContent = { type: "reasoning", id, text }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((text) => LLMEvent.toolInputDelta({ id, name: "echo", text })),
      ]
      const expectedContent = { type: "tool", id, state: { status: "pending", input: text } }
      return {
        delta: SessionEvent.Tool.Input.Delta,
        partialEvents,
        completeEvents: [...partialEvents, LLMEvent.toolInputEnd({ id, name: "echo" })],
        expectedAssistant: { type: "assistant", content: [expectedContent] },
        expectedContent,
      }
    }
  }
}

const verifyEphemeralDeltas = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Stream ${kind}`
    const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
    const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
    const expectedContext = [
      { type: "user", text: prompt },
      kind === "tool input"
        ? {
            type: "assistant",
            finish: "error",
            content: [{ id: fragmentID(kind, "many"), state: { status: "error" } }],
          }
        : fixture.expectedAssistant,
    ]
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    const events = yield* EventV2.Service
    const live = yield* events.subscribe(fixture.delta).pipe(Stream.take(32), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    response = fixture.completeEvents

    const exit = yield* session.resume(sessionID).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(kind === "tool input")

    const { db } = yield* Database.Service
    const deltas = yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.type, EventV2.versionedType(fixture.delta.type, 1)))
      .all()
      .pipe(Effect.orDie)
    const streamed = Array.from(yield* Fiber.join(live))
    expect(streamed).toHaveLength(32)
    if (kind === "text" || kind === "reasoning")
      expect(
        streamed.map((event) =>
          typeof event.data === "object" && event.data !== null && "offset" in event.data
            ? event.data.offset
            : undefined,
        ),
      ).toEqual(chunks.map((_, index) => chunks.slice(0, index).join("").length))
    expect(deltas).toHaveLength(0)
    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)

    yield* replaySessionProjection(sessionID)

    expect(yield* session.context(sessionID)).toMatchObject(expectedContext)
  })

const verifyPartialFlushOnFailure = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Fail after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "partial"), ["Partial"])
    const failure = providerUnavailable()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    responseStream = Stream.concat(Stream.fromIterable(fixture.partialEvents), Stream.fail(failure))

    expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider unavailable" },
        content: [
          kind === "tool input"
            ? { type: "tool", id: fragmentID(kind, "partial"), state: { status: "error" } }
            : fixture.expectedContent,
        ],
      },
    ])
  })

const verifyPartialFlushOnInterruption = (kind: FragmentKind) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const prompt = `Interrupt after ${kind}`
    const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
    const streamed = yield* Deferred.make<void>()
    yield* session.prompt({ sessionID, prompt: Prompt.make({ text: prompt }), resume: false })
    responseStream = Stream.concat(
      Stream.fromIterable(fixture.partialEvents),
      Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
    )

    const runner = yield* SessionRunner.Service
    const fiber = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
    yield* Deferred.await(streamed)
    yield* Fiber.interrupt(fiber)
    expect(yield* session.context(sessionID)).toMatchObject([
      { type: "user", text: prompt },
      {
        type: "assistant",
        finish: "interrupted",
        content: [
          kind === "tool input"
            ? { type: "tool", id: fragmentID(kind, "interrupted"), state: { status: "error" } }
            : fixture.expectedContent,
        ],
      },
    ])
  })

describe("SessionRunnerLLM", () => {
  it.effect("archive cancels queued input and cannot be restarted by a stale resume", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queued work" }),
        delivery: "queue",
        resume: false,
      })
      yield* session.update({ sessionID, archived: true })
      expect(yield* session.pendingInputs(sessionID)).toEqual([])
      yield* session.resume(sessionID)
      yield* session.wait(sessionID)
      expect(requests).toHaveLength(0)
      expect((yield* session.get(sessionID)).time.archived).toBeDefined()
    }),
  )
  it.effect("continues truncated pure text once with tools disabled and retained partial output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Explain briefly" }), resume: false })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "partial" }),
          LLMEvent.textDelta({ id: "partial", text: "First part" }),
          LLMEvent.textEnd({ id: "partial" }),
          LLMEvent.stepFinish({ index: 0, reason: "length" }),
          LLMEvent.finish({ reason: "length" }),
        ],
        fragmentFixture("text", "continued", ["Remaining part"]).completeEvents,
      ]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(requests[1].tools).toEqual([])
      expect(requests[1].toolChoice).toMatchObject({ type: "none" })
      expect(JSON.stringify(requests[1].messages)).toContain("First part")
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({ finish: "stop" })
    }),
  )
  it.effect("recovers a raw protocol rejection through durable history without replaying a valid sibling", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Correct only the rejected call" }),
        resume: false,
      })
      requests.length = 0
      executions.length = 0
      responseStream = LLMClient.stream(
        LLM.request({
          model: OpenAIChat.route.with({ auth: Auth.bearer("fixture") }).model({ id: "offline" }),
          prompt: "fixture",
        }),
      ).pipe(
        Stream.provide(
          fixedResponse(
            sseEvents(
              deltaChunk({
                tool_calls: [
                  { index: 0, id: "bad", function: { name: "echo", arguments: '{"text":' } },
                  { index: 1, id: "sibling", function: { name: "echo", arguments: '{"text":"sibling"}' } },
                ],
              }),
              deltaChunk({}, "tool_calls"),
              usageChunk({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
            ),
          ),
        ),
      )
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "fixed", name: "echo", input: { text: "fixed" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        fragmentFixture("text", "done", ["Completed."]).completeEvents,
      ]
      yield* session.resume(sessionID)
      expect(executions).toEqual(["sibling", "fixed"])
      expect(requests).toHaveLength(3)
      expect(JSON.stringify(requests[1].messages)).toContain("This call was not executed")
      expect((yield* session.context(sessionID)).filter((message) => message.type === "assistant")[0]).toMatchObject({
        tokens: { input: 100, output: 20 },
        finish: "tool-calls",
      })
    }),
  )

  it.effect("honors Stop after an input rejection without starting correction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Stop before correction" }), resume: false })
      requests.length = 0
      executions.length = 0
      const observed = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.toolInputStart({ id: "bad", name: "echo" }),
          LLMEvent.toolInputEnd({ id: "bad", name: "echo" }),
          LLMEvent.toolError({ id: "bad", name: "echo", inputRejected: true, message: "Not executed" }),
        ]),
        Stream.fromEffect(Deferred.succeed(observed, undefined).pipe(Effect.andThen(Effect.never))),
      )
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(observed)
      yield* session.interrupt(sessionID)
      yield* Fiber.await(run)
      expect(requests).toHaveLength(1)
      expect(executions).toHaveLength(0)
    }),
  )

  for (const reason of ["tool-calls", "length"] as const) {
    it.effect(`corrects rejected input once after ${reason} without executing or replaying it`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Write safely" }), resume: false })
        requests.length = 0
        executions.length = 0
        responses = [
          [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolInputStart({ id: "bad", name: "echo" }),
            LLMEvent.toolInputDelta({ id: "bad", name: "echo", text: '{"text":' }),
            LLMEvent.toolInputEnd({ id: "bad", name: "echo" }),
            LLMEvent.toolError({
              id: "bad",
              name: "echo",
              inputRejected: true,
              message: "Not executed: invalid arguments",
            }),
            LLMEvent.stepFinish({ index: 0, reason, usage: { inputTokens: 100, outputTokens: 20 } }),
            LLMEvent.finish({ reason }),
          ],
          [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id: "corrected", name: "echo", input: { text: "fixed" } }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ],
          fragmentFixture("text", "done", ["Done."]).completeEvents,
        ]
        yield* session.resume(sessionID)
        expect(requests).toHaveLength(3)
        expect(executions).toHaveLength(1)
        expect(requests[1].tools.length).toBeGreaterThan(0)
        expect(JSON.stringify(requests[1].messages)).toContain("Not executed: invalid arguments")
        expect(SessionOutcome.inputRejections(yield* session.context(sessionID))).toBe(1)
        expect((yield* session.context(sessionID)).at(-1)).toMatchObject({ finish: "stop" })
      }),
    )
  }
  it.effect("stops after a second rejected-input turn without dispatching either call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Write safely" }), resume: false })
      requests.length = 0
      executions.length = 0
      responses = ["bad-1", "bad-2"].map((id) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        LLMEvent.toolInputEnd({ id, name: "echo" }),
        LLMEvent.toolError({ id, name: "echo", inputRejected: true, message: "Invalid input, not executed" }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      yield* session.resume(sessionID).pipe(Effect.exit)
      expect(requests).toHaveLength(2)
      expect(executions).toHaveLength(0)
      expect(SessionOutcome.derive(yield* session.context(sessionID), false).state).toBe("failed")
    }),
  )

  it.effect("allows an independent input correction after a successful intervening tool turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Correct independent errors" }), resume: false })
      requests.length = 0
      executions.length = 0
      responses = [1, 2].flatMap((index) => [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolInputStart({ id: `bad-${index}`, name: "echo" }),
          LLMEvent.toolInputEnd({ id: `bad-${index}`, name: "echo" }),
          LLMEvent.toolError({
            id: `bad-${index}`,
            name: "echo",
            inputRejected: true,
            message: "Invalid input, not executed",
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: `fixed-${index}`, name: "echo", input: { text: `fixed-${index}` } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ])
      responses.push(fragmentFixture("text", "done", ["Done."]).completeEvents)
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(5)
      expect(executions).toEqual(["fixed-1", "fixed-2"])
      expect(SessionOutcome.inputRejections(yield* session.context(sessionID))).toBe(2)
      expect(SessionOutcome.consecutiveInputRejections(yield* session.context(sessionID))).toBe(0)
    }),
  )

  it.effect("bounds truncated tool regeneration without executing partial arguments", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Write safely" }), resume: false })
      requests.length = 0
      executions.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "partial-tool", name: "echo" }),
        LLMEvent.toolInputDelta({ id: "partial-tool", name: "echo", text: '{"text":' }),
        LLMEvent.stepFinish({ index: 0, reason: "length" }),
        LLMEvent.finish({ reason: "length" }),
      ]
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      expect(requests).toHaveLength(2)
      expect(executions).toEqual([])
      expect(requests[1].tools.length).toBeGreaterThan(0)
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
        finish: "error",
        content: [{ id: "partial-tool", state: { status: "error" } }],
      })
    }),
  )
  it.effect("does not start queued tools after a provider failure and preserves the completed side effect", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run in order" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const failed = yield* events
        .subscribe(SessionEvent.Step.Failed)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "active-write", name: "echo", input: { text: "first" } }),
          LLMEvent.toolCall({ id: "queued-write", name: "echo", input: { text: "second" } }),
        ]),
        Stream.unwrap(Deferred.await(toolExecutionsStarted).pipe(Effect.as(Stream.fail(providerUnavailable())))),
      )
      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      yield* Fiber.join(failed)
      yield* Deferred.succeed(toolExecutionGate, undefined)
      expect(Exit.isFailure(yield* Fiber.join(run))).toBe(true)
      expect(executions).toEqual(["first"])
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
        finish: "error",
        content: [
          { id: "active-write", state: { status: "completed" } },
          {
            id: "queued-write",
            state: { status: "error", error: { message: expect.stringContaining("not executed") } },
          },
        ],
      })
      toolExecutionGate = undefined
      response = fragmentFixture("text", "after-failure", ["New instruction accepted"]).completeEvents
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Reply only" }), resume: false })
      yield* session.resume(sessionID)
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({ finish: "stop" })
    }),
  )
  it.effect("runs a command through a real child Session and returns its findings to the parent", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      const applications = yield* ApplicationTools.Service
      const sessions = yield* SessionV2.Service
      const agents = yield* AgentV2.Service
      const commands = yield* CommandV2.Service
      yield* agents.transform((draft) =>
        draft.update(AgentV2.ID.make("build"), (agent) => {
          agent.mode = "primary"
        }),
      )
      yield* commands.transform((draft) =>
        draft.update("review", (command) => {
          command.subtask = true
        }),
      )
      yield* applications.register({
        task: Tool.make({
          description: TaskTool.description,
          input: TaskTool.Input,
          output: TaskTool.Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const parent = yield* sessions.get(context.sessionID).pipe(Effect.orDie)
              return yield* TaskTool.run(sessions, parent, input, context)
            }).pipe(
              Effect.provideService(AgentV2.Service, agents),
              Effect.provideService(CommandV2.Service, commands),
              Effect.provide(Layer.mock(PermissionV2.Service, { assert: () => Effect.void })),
            ),
        }),
      })
      responses = [
        fragmentFixture("text", "child-text", ["Child review findings"]).completeEvents,
        fragmentFixture("text", "parent-text", ["Parent review summary"]).completeEvents,
      ]
      yield* sessions.prompt({
        sessionID,
        resume: false,
        prompt: Prompt.make({
          text: "Review the changes",
          subtask: {
            command: "review",
            agent: "build",
            model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
          },
        }),
      })
      yield* sessions.resume(sessionID)
      const children = (yield* sessions.list()).filter((session) => session.parentID === sessionID)
      expect(children).toHaveLength(1)
      expect(requests.map((request) => request.model.id)).toEqual([replacementModel.id, model.id])
      expect(JSON.stringify(requests[1].messages)).toContain("Child review findings")
      expect(
        (yield* sessions.messages({ sessionID: children[0].id })).some(
          (message) =>
            message.type === "assistant" &&
            message.content.some((part) => part.type === "text" && part.text === "Child review findings"),
        ),
      ).toBe(true)
      yield* sessions.resume(sessionID)
      expect((yield* sessions.list()).filter((session) => session.parentID === sessionID)).toHaveLength(1)
      requests.length = 0
    }).pipe(Effect.provide(CommandV2.locationLayer)),
  )

  it.effect("delegates a durable subtask once before asking the parent provider to continue", () =>
    Effect.gen(function* () {
      yield* setup
      requests.length = 0
      const applications = yield* ApplicationTools.Service
      const session = yield* SessionV2.Service
      const calls: (typeof TaskTool.Input.Type)[] = []
      yield* applications.register({
        task: Tool.make({
          description: "Command child",
          input: TaskTool.Input,
          output: TaskTool.Output,
          execute: (input) =>
            Effect.sync(() => {
              expect(requests.length).toBe(0)
              calls.push(input)
              return { task_id: SessionV2.ID.make("ses_command_child"), content: "Child findings" }
            }),
        }),
      })
      yield* session.prompt({
        sessionID,
        resume: false,
        prompt: Prompt.make({
          text: "Review changes",
          subtask: {
            command: "review",
            agent: "build",
            model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
          },
        }),
      })
      yield* session.resume(sessionID)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ command: "review", prompt: "Review changes", model: { id: "replacement" } })
      expect(requests).toHaveLength(1)
      const history = yield* session.messages({ sessionID })
      expect(
        history.some(
          (message) =>
            message.type === "assistant" &&
            message.content.some((part) => part.type === "tool" && part.state.status === "completed"),
        ),
      ).toBe(true)
      yield* session.resume(sessionID)
      expect(calls).toHaveLength(1)
      requests.length = 0
    }),
  )

  it.effect("advertises and executes a globally attached application tool", () =>
    Effect.gen(function* () {
      yield* setup
      const applicationTools = yield* ApplicationTools.Service
      const session = yield* SessionV2.Service
      const contexts: Tool.Context[] = []
      yield* applicationTools.register({
        application_context: Tool.make({
          description: "Read application context",
          input: Schema.Struct({ query: Schema.String }),
          output: Schema.Struct({ answer: Schema.String }),
          execute: ({ query }, context) =>
            Effect.sync(() => {
              contexts.push(context)
              return { answer: query.toUpperCase() }
            }),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use application context" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-application", name: "application_context", input: { query: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(requests[0]?.tools.map((tool) => tool.name)).toContain("application_context")
      expect(contexts).toEqual([
        {
          sessionID,
          agent: AgentV2.ID.make("build"),
          assistantMessageID: expect.stringMatching(/^msg_/),
          toolCallID: "call-application",
        },
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use application context" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-application",
              state: { status: "completed", structured: { answer: "HELLO" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("starts a real runner turn after default prompt recording", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []

      const message = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run automatically" }) })

      expect(requests).toHaveLength(1)
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: message.id, type: "user", text: "Run automatically" },
      ])
    }),
  )

  it.effect("resolves each queued input's own model after its safe promotion boundary", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      requests.length = 0
      response = []
      for (const id of ["fake-model", "replacement"]) {
        yield* session.prompt({
          sessionID,
          delivery: "queue",
          resume: false,
          prompt: Prompt.make({
            text: id,
            selection: { agent: "build", model: { id: ModelV2.ID.make(id), providerID: ProviderV2.ID.make("fake") } },
          }),
        })
      }
      expect(requests).toHaveLength(0)
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.model.id)).toEqual([model.id, replacementModel.id])
      expect(userTexts(requests[0])).toEqual(["fake-model"])
      expect(userTexts(requests[1])).toEqual(["fake-model", "replacement"])
    }),
  )

  it.effect("records the input boundary and context epoch consumed by an assistant turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-consumption", ["Recorded"]).completeEvents

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Trace this turn" }), resume: false })
      yield* session.resume(sessionID)

      const assistant = (yield* session.context(sessionID)).findLast((message) => message.type === "assistant")
      if (assistant?.type !== "assistant") return yield* Effect.die("Assistant turn was not projected")
      expect(typeof assistant.inputSequence).toBe("number")
      expect(typeof assistant.contextEpoch).toBe("number")
      if (assistant.inputSequence === undefined || assistant.contextEpoch === undefined)
        return yield* Effect.die("Assistant turn consumption boundary was not recorded")
      expect(assistant.inputSequence).toBeGreaterThanOrEqual(assistant.contextEpoch)
    }),
  )

  it.effect("streams one request with registry definitions from chronological V2 user history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.model).toBe(model)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["defect", "echo"])
      expect(requests[0]?.messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([
        { role: "user", content: [{ type: "text", text: "First" }] },
        { role: "user", content: [{ type: "text", text: "Second" }] },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(2)
    }),
  )

  it.effect("retries the first provider turn after system context becomes available", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.create()
      systemUnavailable = true
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(SystemContext.InitializationBlocked)
      expect(requests).toHaveLength(0)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      systemUnavailable = false
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "First" }) })

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user"])
    }),
  )

  it.effect("interrupts a source Location runner after a Session moves", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
      })
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
    }),
  )

  it.effect("fails gracefully when a stored context snapshot cannot be decoded", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      response = []
      yield* session.resume(sessionID)
      yield* db
        .update(SessionContextEpochTable)
        .set({ snapshot: { invalid: { value: "bad" } } })
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      requests.length = 0

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(ContextSnapshotDecodeError)
      expect(requests).toHaveLength(0)
    }),
  )

  it.effect("reuses one durable baseline after the context producer changes", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => privilegedTexts(request))).toEqual([["Initial context"], ["Initial context"]])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([{ type: "text", text: "Changed context" }])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, "session.next.context.updated.1"))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("includes the effective default agent system before durable context", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-build", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(privilegedTexts(requests.at(-1))).toEqual(["Build agent instructions", "Initial context"])
    }),
  )

  it.effect("uses the configured default agent system for omitted-agent sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) => {
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        })
        editor.default(AgentV2.ID.make("reviewer"))
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-reviewer", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(privilegedTexts(requests.at(-1))).toEqual(["Reviewer instructions", "Initial context"])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("uses an explicitly selected non-build agent system", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        }),
      )
      yield* db
        .update(SessionTable)
        .set({ agent: "reviewer" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = fragmentFixture("text", "text-selected", ["Done"]).completeEvents
      yield* session.resume(sessionID)

      expect(privilegedTexts(requests.at(-1))).toEqual(["Reviewer instructions", "Initial context"])
      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  it.effect("updates selected-agent skill guidance after an agent switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        agent: "reviewer",
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => privilegedTexts(request))).toEqual([
        ["Initial context\n\nBuild skills"],
        ["Initial context\n\nBuild skills"],
      ])
      expect(systemTexts(requests[1]!)).toContainEqual(expect.stringContaining("Reviewer skills"))
    }),
  )

  it.effect("keeps the sampled agent when selection changes during observation", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests.map((request) => privilegedTexts(request))).toEqual([["Initial context\n\nBuild skills"]])
    }),
  )

  it.effect("keeps the sampled model when selection changes during model resolution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.ModelSwitched, {
            sessionID,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(1),
            model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      expect(requests.map((request) => request.model)).toEqual([model])
      expect(requests.map((request) => privilegedTexts(request))).toEqual([["Initial context"]])
    }),
  )

  it.effect("admits removed context as a chronological System message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemRemoved = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[1]?.messages.at(-1)?.content).toEqual([
        { type: "text", text: "System context source removed: test/context" },
      ])
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  it.effect("keeps the baseline and chronological System updates after a model switch", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => privilegedTexts(request))).toEqual([
        ["Initial context"],
        ["Initial context"],
        ["Initial context"],
      ])
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user", "system"])
      expect(requests[2]?.messages.filter((message) => message.role === "system")).toHaveLength(2)
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "user",
        "system",
        "model-switched",
        "user",
        "system",
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(6)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fourth" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("preserves the baseline while context is temporarily unavailable", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      systemUnavailable = false
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => privilegedTexts(request))).toEqual([
        ["Initial context"],
        ["Initial context"],
        ["Initial context"],
      ])
    }),
  )

  it.effect("rebuilds the baseline directly after completed compaction", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests.map((request) => privilegedTexts(request))).toEqual([
        ["Initial context"],
        ["Replacement context"],
      ])
      yield* replaySessionProjection(sessionID)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)
    }),
  )

  it.effect("automatically compacts into a completed summary and retained recent turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      response = fragmentFixture("text", "text-first", ["Earlier answer"]).completeEvents
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Keep JavaScript, no dependencies.\n" + "Earlier question ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      currentModel = compactModel
      requests.length = 0
      responses = [
        fragmentFixture("text", "text-summary", [handoff("Preserve the task")]).completeEvents,
        fragmentFixture("text", "text-final", ["Continued"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({
          text: "Correction: keep TypeScript instead, still no dependencies.\n" + "Recent exact request ".repeat(180),
        }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain("## Objective")
      expect(JSON.stringify(requests[0].system)).toContain("conversation summarizer, not the task execution agent")
      expect(userTexts(requests[1])).toHaveLength(1)
      expect(userTexts(requests[1])[0]).toContain(`<summary>\n${handoff("Preserve the task")}\n</summary>`)
      expect(userTexts(requests[1])[0]).toContain("<original-user-requests>")
      expect(userTexts(requests[1])[0]).toContain("Earlier question ".repeat(180))
      expect(userTexts(requests[1])[0]).toContain(
        `[User]: Correction: keep TypeScript instead, still no dependencies.\n${"Recent exact request ".repeat(180)}`,
      )

      const context = yield* (yield* SessionStore.Service).context(sessionID)
      expect(context.map((message) => message.type)).toEqual(["compaction", "assistant"])
      expect(context[0]).toMatchObject({
        type: "compaction",
        summary: handoff("Preserve the task"),
      })

      requests.length = 0
      executions.length = 0
      responses = [
        fragmentFixture("text", "text-summary-2", [handoff("Preserve the updated task")]).completeEvents,
        fragmentFixture("text", "text-final-2", ["Continued again"]).completeEvents,
      ]
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Newest exact request ".repeat(180) }),
        resume: false,
      })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0])[0]).toContain(
        `<previous-summary>\n${handoff("Preserve the task")}\n</previous-summary>`,
      )
      expect(userTexts(requests[0])[0]).toContain("Recent exact request")
      expect(userTexts(requests[1])[0]).toContain("Earlier question ".repeat(180))
      expect(userTexts(requests[1])[0]).toContain("Recent exact request ".repeat(180))
      expect(userTexts(requests[1])[0]).toContain("Newest exact request ".repeat(180))
      expect((yield* (yield* SessionStore.Service).context(sessionID))[0]).toMatchObject({
        type: "compaction",
        summary: handoff("Preserve the updated task"),
      })
      yield* replaySessionProjection(sessionID)
      currentModel = model
      requests.length = 0
      response = fragmentFixture("text", "after-replay", ["Resumed without losing requirements"]).completeEvents
      yield* session.resume(sessionID)
      expect(userTexts(requests[0])[0]).toContain("Earlier question ".repeat(180))
      expect(userTexts(requests[0])[0]).toContain("Recent exact request ".repeat(180))
      expect(userTexts(requests[0])[0]).toContain("Newest exact request ".repeat(180))
      expect(userTexts(requests[0])[0]).toContain("Keep JavaScript, no dependencies.")
      expect(userTexts(requests[0])[0]).toContain("Correction: keep TypeScript instead, still no dependencies.")
      expect(executions).toEqual([])
      const before = yield* session.context(sessionID)
      const runner = yield* SessionRunner.Service
      currentModel = recoveryModel
      responses = [
        fragmentFixture("text", "invalid-replacement", ["## Objective\n- Drop all old constraints"]).completeEvents,
      ]
      expect(yield* runner.compact(sessionID)).toBe(false)
      expect(yield* session.context(sessionID)).toEqual(before)
    }),
  )

  it.effect("forces one compaction and retries after provider context overflow", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
        fragmentFixture("text", "text-summary", [handoff("Recover overflow")]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[1])[0]).toContain("## Objective")
      expect(userTexts(requests[2])[0]).toContain(`<summary>\n${handoff("Recover overflow")}\n</summary>`)
      expect(userTexts(requests[2])[0]).toContain("Earlier question ".repeat(700))
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: handoff("Recover overflow") },
        { type: "assistant", finish: "stop" },
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("persists a second context overflow after one recovery", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      const overflow = () => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      responses = [
        overflow(),
        fragmentFixture("text", "text-summary", [handoff("Recover once")]).completeEvents,
        overflow(),
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "error", error: { message: expect.stringContaining("provider context limit") } },
      ])
    }),
  )

  it.effect("recovers once from a raw context overflow failure", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responseStream = Stream.fail(
        new LLMError({
          module: "test",
          method: "stream",
          reason: new InvalidRequestReason({
            message: "prompt too long",
            classification: "context-overflow",
          }),
        }),
      )
      responses = [
        fragmentFixture("text", "text-summary", [handoff("Recover raw overflow")]).completeEvents,
        fragmentFixture("text", "text-final", ["Recovered"]).completeEvents,
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: handoff("Recover raw overflow") },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("publishes the original overflow when recovery summarization fails", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        [LLMEvent.providerError({ message: "summary unavailable" })],
      ]
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)

      expect(requests).toHaveLength(2)
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(false)
      expect(context.slice(-2)).toMatchObject([
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "error", error: { message: expect.stringContaining("provider context limit") } },
      ])

      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType("session.next.compaction.failed", 1)))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({ data: { error: { message: "summary unavailable" } } })

      responses = [[LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })]]
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      expect(requests).toHaveLength(3)
    }),
  )

  for (const [label, summaryEvents] of [
    ["missing sections", fragmentFixture("text", "bad-summary", ["## Objective\n- All done"]).completeEvents],
    [
      "leaked tool markup",
      fragmentFixture("text", "bad-summary", [handoff("Continue") + '\n<｜DSML｜invoke name="bash">']).completeEvents,
    ],
    [
      "actual tool call",
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "summary-tool", name: "echo", input: { text: "must not execute" } }),
        ...fragmentFixture("text", "bad-summary", [handoff("Continue")]).completeEvents,
      ],
    ],
  ] as const)
    it.effect(`rejects ${label} without committing a compaction or retrying the same failed source`, () =>
      Effect.gen(function* () {
        const session = yield* setupOverflowRecovery
        const overflow = [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })]
        responses = [overflow, [...summaryEvents]]
        expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
        expect(requests).toHaveLength(2)
        const context = yield* session.context(sessionID)
        expect(context.some((message) => message.type === "compaction")).toBe(false)
        expect(
          context.some((message) => message.type === "user" && message.text === "Earlier question ".repeat(700)),
        ).toBe(true)
        expect(executions).not.toContain("must not execute")
        const database = yield* Database.Service
        const failed = yield* database.db
          .select({ data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType("session.next.compaction.failed", 1)))
          .all()
          .pipe(Effect.orDie)
        expect(failed).toHaveLength(1)
        responses = [overflow]
        expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
        expect(requests).toHaveLength(3)
      }),
    )

  it.effect("records an unfit compaction without dropping requests or calling a summary provider", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Keep this exact constraint ".repeat(3000) }),
        resume: false,
      })
      currentModel = compactModel
      requests.length = 0
      responses = [[LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })]]
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0])[0]).toContain("Keep this exact constraint ".repeat(3000))
      const database = yield* Database.Service
      const failed = yield* database.db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType("session.next.compaction.failed", 1)))
        .all()
        .pipe(Effect.orDie)
      expect(failed).toHaveLength(1)
      expect(failed[0]?.data).toMatchObject({
        error: { message: expect.stringContaining("cannot fit") },
        usage: { reported: false },
      })
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("interrupts overflow recovery while the summary provider is running", () =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery
      responses = [
        [LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" })],
        fragmentFixture("text", "text-summary", [handoff("Interrupted")]).completeEvents,
      ]
      const firstGate = yield* Deferred.make<void>()
      const summaryGate = yield* Deferred.make<void>()
      streamGate = firstGate
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      streamGate = summaryGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow

      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      streamGate = undefined
      expect(requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  it.effect("preserves effective System updates while compaction rebaseline is blocked", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })

      requests.length = 0
      response = []
      yield* session.resume(sessionID)
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* session.resume(sessionID)
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Third" }), resume: false })
      yield* session.resume(sessionID)

      expect(privilegedTexts(requests.at(-1))).toEqual(["Initial context"])
      expect(systemTexts(requests.at(-1)!)).toContain("Changed context")
    }),
  )

  it.effect("projects reasoning and tool events without executing or continuing tools", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use tools" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-1" }),
        LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" }),
        LLMEvent.reasoningEnd({ id: "reasoning-1" }),
        LLMEvent.toolInputStart({ id: "call-error", name: "write" }),
        LLMEvent.toolInputDelta({ id: "call-error", name: "write", text: '{"path":"README.md"}' }),
        LLMEvent.toolInputEnd({ id: "call-error", name: "write" }),
        LLMEvent.toolCall({ id: "call-error", name: "write", input: { path: "README.md" }, providerExecuted: true }),
        LLMEvent.toolError({ id: "call-error", name: "write", message: "Denied" }),
        LLMEvent.toolResult({ id: "call-error", name: "write", result: { type: "error", value: "Denied" } }),
        LLMEvent.toolCall({
          id: "call-provider",
          name: "web_search",
          input: { query: "hello" },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.toolResult({
          id: "call-provider",
          name: "web_search",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Hello" },
              { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "hello.png" },
            ],
          },
          providerExecuted: true,
          providerMetadata: { fake: { source: "provider" } },
        }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "tool-calls",
          usage: {
            inputTokens: 10,
            nonCachedInputTokens: 8,
            outputTokens: 4,
            reasoningTokens: 1,
            cacheReadInputTokens: 2,
          },
        }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["defect", "echo"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use tools" },
        {
          type: "assistant",
          finish: "tool-calls",
          tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
          content: [
            { type: "reasoning", id: "reasoning-1", text: "Think" },
            {
              type: "tool",
              id: "call-error",
              name: "write",
              state: {
                status: "error",
                input: { path: "README.md" },
                error: { type: "unknown", message: "Denied" },
              },
            },
            {
              type: "tool",
              id: "call-provider",
              name: "web_search",
              provider: { executed: true, metadata: { fake: { source: "provider" } } },
              state: {
                status: "completed",
                input: { query: "hello" },
                structured: {},
                content: [
                  { type: "text", text: "Hello" },
                  { type: "file", mime: "image/png", uri: "data:image/png;base64,aGVsbG8=", name: "hello.png" },
                ],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("continues with reloaded history after durably settling one local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo this" }), resume: false })

      requests.length = 0
      authorizations.length = 0
      executions.length = 0
      streamGate = undefined
      streamStarted = undefined
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(authorizations).toMatchObject([{ sessionID, toolCallID: "call-echo" }])
      expect(executions).toEqual(["hello"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo this" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-echo",
              name: "echo",
              state: {
                status: "completed",
                input: { text: "hello" },
                structured: { text: "hello" },
                content: [{ type: "text", text: "hello" }],
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-final", text: "Done" }] },
      ])
    }),
  )

  it.effect("reloads a model switch before a tool-driven continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo this" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const run = yield* Effect.forkChild(session.resume(sessionID))
      yield* Deferred.await(toolExecutionsStarted)
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: DateTime.makeUnsafe(1),
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)

      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map((request) => privilegedTexts(request))).toEqual([["Initial context"], ["Initial context"]])
      expect(systemTexts(requests[1]!)).toContain("Replacement context")
    }),
  )

  it.effect("restores durable reasoning provider metadata in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Think first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id: "reasoning-anthropic" }),
        LLMEvent.reasoningDelta({ id: "reasoning-anthropic", text: "Signed thought" }),
        LLMEvent.reasoningEnd({ id: "reasoning-anthropic", providerMetadata: { anthropic: { signature: "sig_1" } } }),
        LLMEvent.reasoningStart({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        }),
        LLMEvent.reasoningDelta({ id: "reasoning-openai", text: "Encrypted thought" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-openai",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        }),
        LLMEvent.reasoningStart({ id: "reasoning-openrouter" }),
        LLMEvent.reasoningEnd({
          id: "reasoning-openrouter",
          providerMetadata: {
            openrouter: { reasoning_details: [{ type: "reasoning.encrypted", data: "opaque", index: 0 }] },
          },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Think first" },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
            {
              type: "reasoning",
              text: "Encrypted thought",
              providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
            },
            {
              type: "reasoning",
              text: "",
              providerMetadata: {
                openrouter: { reasoning_details: [{ type: "reasoning.encrypted", data: "opaque", index: 0 }] },
              },
            },
          ],
        },
      ])

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages[1]?.content).toEqual([
        { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
        {
          type: "reasoning",
          text: "Encrypted thought",
          providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
        },
        {
          type: "reasoning",
          text: "",
          providerMetadata: {
            openrouter: { reasoning_details: [{ type: "reasoning.encrypted", data: "opaque", index: 0 }] },
          },
        },
      ])
    }),
  )

  it.effect("replays durable provider-executed tool results inline in a second-turn request", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Search first" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        }),
        LLMEvent.toolResult({
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      yield* replaySessionProjection(sessionID)

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      response = []
      yield* session.resume(sessionID)

      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
      expect(requests[1]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "hosted-search",
          name: "web_search",
          input: { query: "Effect" },
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "hosted-search" } },
        },
        {
          type: "tool-result",
          id: "hosted-search",
          name: "web_search",
          result: { type: "json", value: [{ title: "Effect" }] },
          providerExecuted: true,
          providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
        },
      ])
    }),
  )

  it.effect("executes recorded local tools in order while the provider continues streaming", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo five times" }), resume: false })

      requests.length = 0
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const providerGate = yield* Deferred.make<void>()
      const callsRecorded = yield* Deferred.make<void>()
      response = []
      responses = undefined
      const initial = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        ...Array.from({ length: 5 }, (_, index) =>
          LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
        ),
      ])
      const final = Stream.fromIterable([
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      streamGate = undefined
      responseStream = Stream.concat(
        initial.pipe(Stream.ensuring(Deferred.succeed(callsRecorded, undefined))),
        Stream.fromEffect(Deferred.await(providerGate)).pipe(Stream.flatMap(() => final)),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(toolExecutionsStarted)

      expect(executions).toEqual(["0"])
      expect(maxActiveToolExecutions).toBe(1)
      yield* Deferred.succeed(providerGate, undefined)
      yield* Deferred.await(callsRecorded)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo five times" },
        {
          type: "assistant",
          content: Array.from({ length: 5 }, (_, index) => ({
            type: "tool",
            id: `call-echo-${index}`,
            state: { status: "running", input: { text: `${index}` } },
          })),
        },
      ])

      expect(requests).toHaveLength(1)

      yield* Deferred.succeed(toolExecutionGate, undefined)
      yield* Fiber.join(run)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(executions).toEqual(["0", "1", "2", "3", "4"])
      expect(maxActiveToolExecutions).toBe(1)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("settles repeated provider-local tool call IDs against their owning assistant messages", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo twice" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "first" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "second" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      yield* session.resume(sessionID)

      expect(executions).toEqual(["first", "second"])
      expect(requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("joins concurrent resume calls into one active provider run", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run once" }), resume: false })

      requests.length = 0
      responses = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-once" }),
        LLMEvent.textDelta({ id: "text-once", text: "Once" }),
        LLMEvent.textEnd({ id: "text-once" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Run once" },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-once", text: "Once" }] },
      ])
    }),
  )

  it.effect("steers an active provider turn with newly recorded prompts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Change direction"])
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
    }),
  )

  it.effect("promotes queued input after continuation ends", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Wait until continuation ends" }),
        delivery: "queue",
      })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Wait until continuation ends"])
    }),
  )

  it.effect("preserves durable queued input for a later wake after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run after interrupt" }),
        delivery: "queue",
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(true)
      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Run after interrupt"])
    }),
  )

  it.effect("preserves durable steering input for a later resume after interruption", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt current work" }), resume: false })

      requests.length = 0
      responses = [
        [],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Steer after interrupt" }),
      })
      yield* session.interrupt(sessionID)
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)

      const resumed = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(resumed)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(requests[1]!)).toEqual(["Interrupt current work", "Steer after interrupt"])
    }),
  )

  it.effect("promotes queued inputs one at a time in FIFO order", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue second" }), delivery: "queue" })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual(["Start working", "Queue first", "Queue second"])
    }),
  )

  it.effect("promotes queued input after steering continuation ends", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start steering" }), resume: false })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Queue for later" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[0]!)).toEqual(["Start steering"])
      expect(userTexts(requests[1]!)).toEqual(["Start steering", "Queue for later"])
    }),
  )

  it.effect("promotes steers before the next queued input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      const firstGate = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      streamGate = firstGate

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (requests.length < 1) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue first" }), delivery: "queue" })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Queue second" }), delivery: "queue" })
      streamGate = secondGate
      yield* Deferred.succeed(firstGate, undefined)
      while (requests.length < 2) yield* Effect.yieldNow
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Steer before next queued input" }) })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Also steer before next queued input" }) })
      yield* Deferred.succeed(secondGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined

      expect(requests).toHaveLength(4)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Queue first"])
      expect(userTexts(requests[2]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
      ])
      expect(userTexts(requests[3]!)).toEqual([
        "Start working",
        "Queue first",
        "Steer before next queued input",
        "Also steer before next queued input",
        "Queue second",
      ])
    }),
  )

  it.effect("coalesces multiple active steering prompts into one continuation turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First steer" }) })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second steer" }) })
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "First steer", "Second steer"])
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* Effect.yieldNow
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("runs steering input accepted while the active provider turn fails", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start working" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover with this" }) })
      yield* Deferred.succeed(streamGate, undefined)
      expect(yield* Fiber.join(first).pipe(Effect.flip)).toBe(streamFailure)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(userTexts(requests[1]!)).toEqual(["Start working", "Recover with this"])
    }),
  )

  for (const action of ["continue", "retry", "abandon"] as const) {
    it.effect(`requires explicit ${action} for an unfinished durable turn`, () =>
      Effect.gen(function* () {
        yield* setup
        requests.length = 0
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const database = yield* Database.Service
        yield* session.prompt({
          sessionID,
          prompt: Prompt.make({ text: "Original unfinished request" }),
          resume: false,
        })
        yield* SessionInput.promoteSteers(database.db, events, sessionID, Number.MAX_SAFE_INTEGER)
        const assistantMessageID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          timestamp: yield* DateTime.now,
          agent: "build",
          model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
        })
        expect(yield* session.outcome(sessionID)).toMatchObject({
          state: "interrupted",
          outcomeUnknown: true,
          messageID: assistantMessageID,
        })
        expect(requests).toHaveLength(0)
        expect(Exit.isFailure(yield* Effect.exit(session.recover({ sessionID, messageID: "stale", action })))).toBe(
          true,
        )
        response = fragmentFixture("text", "recovered-answer", ["Recovered safely"]).completeEvents
        yield* session.recover({ sessionID, messageID: assistantMessageID, action })
        if (action === "abandon") {
          expect(requests).toHaveLength(0)
          expect((yield* session.get(sessionID)).time.archived).toBeDefined()
          expect(
            Exit.isFailure(
              yield* Effect.exit(session.recover({ sessionID, messageID: assistantMessageID, action: "continue" })),
            ),
          ).toBe(true)
          return
        }
        yield* session.wait(sessionID)
        expect(requests).toHaveLength(1)
        const texts = userTexts(requests[0])
        expect(texts.at(-1)).toContain(
          action === "retry" ? "Original unfinished request" : "不要假定未结束的命令已经成功",
        )
        expect((yield* session.outcome(sessionID)).state).toBe("completed_unverified")
      }),
    )
  }

  it.effect("durably fails local tools left running by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover interrupted tool" }), resume: false })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        name: "echo",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        text: '{"text":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-interrupted",
        tool: "echo",
        input: { text: "stale" },
        provider: { executed: false },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool" },
        {
          type: "assistant",
          finish: "interrupted",
          content: [
            {
              type: "tool",
              id: "call-interrupted",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails hosted tools left running by a prior process before continuing inline", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted hosted tool" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        name: "web_search",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        text: '{"query":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        tool: "web_search",
        input: { query: "stale" },
        provider: { executed: true, metadata: { openai: { itemId: "call-hosted-interrupted" } } },
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"])
      expect(requests[0]?.messages[1]?.content).toMatchObject([
        {
          type: "tool-call",
          id: "call-hosted-interrupted",
          providerExecuted: true,
          providerMetadata: { openai: { itemId: "call-hosted-interrupted" } },
        },
        { type: "tool-result", id: "call-hosted-interrupted", providerExecuted: true, result: { type: "error" } },
      ])
    }),
  )

  it.effect("durably fails pending tool input left by a prior process before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Recover interrupted tool input" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: yield* DateTime.now,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID: "call-pending-interrupted",
        name: "echo",
      })
      requests.length = 0
      response = []
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool input" },
        { type: "assistant", content: [{ type: "tool", id: "call-pending-interrupted", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("promotes the first queued input when woken while idle", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Wait in queue" }),
        delivery: "queue",
        resume: false,
      })

      requests.length = 0
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Wait in queue"])
    }),
  )

  it.effect("retries inbox input after prompt projection rolls back", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const defect = new Error("fail after prompt promotion")
      let fail = true
      yield* events.project(SessionEvent.Prompted, () => (fail ? Effect.die(defect) : Effect.void))
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Recover promoted input" }), resume: false })

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
      fail = false
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* (yield* SessionExecution.Service).wake(sessionID)
      while (requests.length === 0) yield* Effect.yieldNow

      expect(userTexts(requests[0]!)).toEqual(["Recover promoted input"])
    }),
  )

  it.effect("does not strand a committed promotion when a post-commit listener defects", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.listen((event) =>
        event.type === SessionEvent.Prompted.type ? Effect.die("fail after prompt promotion commits") : Effect.void,
      )
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run committed promotion" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(sessionID)

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Run committed promotion"])
    }),
  )

  it.effect("runs different sessions concurrently", () =>
    Effect.gen(function* () {
      yield* setup
      yield* insertSession(otherSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run first" }), resume: false })
      yield* session.prompt({ sessionID: otherSessionID, prompt: Prompt.make({ text: "Run second" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(otherSessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(2)
      expect(requests.map((request) => request.providerOptions?.openai?.promptCacheKey)).toEqual([
        sessionID,
        otherSessionID,
      ])
      yield* Deferred.succeed(streamGate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      streamGate = undefined
      streamStarted = undefined
    }),
  )

  it.effect("bounds 64-character session prompt cache keys", () =>
    Effect.gen(function* () {
      yield* setup
      const longSessionID = SessionV2.ID.make(`ses_${"a".repeat(64)}`)
      const otherLongSessionID = SessionV2.ID.make(`ses_${"b".repeat(64)}`)
      yield* insertSession(longSessionID)
      yield* insertSession(otherLongSessionID)
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: longSessionID,
        prompt: Prompt.make({ text: "Run long session" }),
        resume: false,
      })
      yield* session.prompt({
        sessionID: otherLongSessionID,
        prompt: Prompt.make({ text: "Run other long session" }),
        resume: false,
      })

      requests.length = 0
      yield* session.resume(longSessionID)
      yield* session.resume(otherLongSessionID)

      const keys = requests.map((request) => request.providerOptions?.openai?.promptCacheKey)
      expect(keys).toEqual([longSessionID.slice(4), otherLongSessionID.slice(4)])
      expect(keys.every((key) => typeof key === "string" && key.length === 64)).toBe(true)
      expect(keys[0]).not.toBe(keys[1])
    }),
  )

  it.effect("fans out one failed run and allows a later retry", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Retry after failure" }), resume: false })

      requests.length = 0
      responses = undefined
      response = []
      streamFailure = providerUnavailable()
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(requests).toHaveLength(1)
      yield* Deferred.succeed(streamGate, undefined)
      const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
      expect(secondExit).toEqual(firstExit)

      streamFailure = undefined
      streamGate = undefined
      streamStarted = undefined
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("durably settles local tool failures before continuing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call missing" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-missing", name: "missing", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-error" }),
          LLMEvent.textDelta({ id: "text-after-error", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-error" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = undefined
      streamStarted = undefined

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call missing" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-missing",
              state: { status: "error", error: { message: "Unknown tool: missing" } },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-after-error", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("returns unexpected local tool defects to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call defect" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-defect", name: "defect", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-after-defect" }),
          LLMEvent.textDelta({ id: "text-after-defect", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-after-defect" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call defect" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-defect",
              state: {
                status: "error",
                error: { type: "unknown", message: "Tool execution failed: unexpected tool defect" },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
    }),
  )

  it.effect("persists schema rejection as unexecuted verification input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        bash: Tool.make({
          description: "Schema boundary",
          input: Schema.Struct({ command: Schema.String, verification_report: Schema.Boolean }),
          output: Schema.Struct({}),
          execute: () => Effect.die("Rejected input must not execute"),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Verify the artifact" }), resume: false })
      const stop = fragmentFixture("text", "done", ["Verification not performed."]).completeEvents
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "bad-report",
            name: "bash",
            input: { command: "echo report", verification_report: { checks: [] } },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        stop,
        stop,
      ]
      yield* session.resume(sessionID)
      const context = yield* session.context(sessionID)
      const tool = context
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((part) => part.type === "tool")
      expect(tool).toMatchObject({ provider: { resultMetadata: { zaovra: { inputRejected: true } } } })
      expect(SessionOutcome.derive(context, false).checks).toMatchObject([{ execution: "not-run" }])
      expect(SessionOutcome.recoveryFailures(context)).toBe(0)
    }),
  )

  it.effect("reviews green engineering work once and does not repeat after compaction or resume", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const events = yield* EventV2.Service
      yield* registry.register({
        bash: Tool.make({
          description: "Green check",
          input: Schema.Struct({}),
          output: Schema.Struct({ exit: Schema.Number }),
          execute: () => Effect.succeed({ exit: 0 }),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Check empty CSV round trips" }), resume: false })
      const tool = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "green", name: "bash", input: {} }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      const stop = fragmentFixture("text", "done", ["Done."]).completeEvents
      requests.length = 0
      responses = [tool, stop, stop]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(3)
      expect(JSON.stringify(requests[2]!.messages)).toContain("Verification closing review:")
      expect(JSON.stringify(requests[2]!.messages)).toContain("empty/minimum values")
      expect(JSON.stringify(requests[2]!.messages)).toContain("Current host verification evidence")
      expect(yield* session.outcome(sessionID)).toMatchObject({ state: "completed_unverified" })
      const messageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID,
        timestamp: DateTime.makeUnsafe(2),
        reason: "manual",
        text: "Work and review already performed",
        recent: "",
      })
      requests.length = 0
      responses = [tool, stop]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain("Verification closing review:")
      expect(JSON.stringify(requests.at(-1)!.messages)).toContain("Current host verification evidence")
      const database = yield* Database.Service
      const evidenceHistory = yield* SessionOutcome.history(database.db, sessionID)
      expect(
        evidenceHistory.some((message) => message.type === "user" && message.text === "Check empty CSV round trips"),
      ).toBe(true)
      expect((yield* session.context(sessionID)).some((message) => message.type === "user")).toBe(false)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Now check malformed CSV" }), resume: false })
      requests.length = 0
      responses = [tool, stop, stop]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(3)
      expect(JSON.stringify(requests[2]!.messages)).toContain("Verification closing review:")
    }),
  )

  it.effect(
    "continues durable acceptance after two compactions without replaying tools or inheriting another task",
    () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const registry = yield* ToolRegistry.Service
        const events = yield* EventV2.Service
        const database = yield* Database.Service
        let executions = 0
        yield* registry.register({
          bash: Tool.make({
            description: "Observed execution fixture",
            input: Schema.Struct({}),
            output: Schema.Struct({ exit: Schema.Number }),
            execute: () =>
              Effect.sync(() => {
                executions++
                return { exit: 0 }
              }),
          }),
        })
        const original = "实现 CSV 往返；交付 README.md。"
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: original }), resume: false })
        const call = (id: string, name: string) => [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id, name, input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]
        const stop = fragmentFixture("text", "done", ["Done."]).completeEvents
        responses = [call("executed-once", "bash"), stop, stop]
        yield* session.resume(sessionID)
        for (const index of [1, 2]) {
          const messageID = SessionMessage.ID.create()
          yield* events.publish(SessionEvent.Compaction.Started, {
            sessionID,
            messageID,
            timestamp: DateTime.makeUnsafe(index * 2),
            reason: "manual",
          })
          yield* events.publish(SessionEvent.Compaction.Ended, {
            sessionID,
            messageID,
            timestamp: DateTime.makeUnsafe(index * 2 + 1),
            reason: "manual",
            text: "Everything done; README not needed",
            recent: "",
          })
        }
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "继续" }), resume: false })
        requests.length = 0
        responses = [stop, call("inspect-original", "verification_review"), stop]
        yield* session.resume(sessionID)
        expect(requests).toHaveLength(3)
        expect(JSON.stringify(requests[1].messages)).toContain("Verification closing review:")
        expect(JSON.stringify(requests[1].messages)).toContain("交付 README.md")
        const history = yield* SessionOutcome.history(database.db, sessionID)
        expect(SessionOutcome.requested(history).clauses).toEqual(["实现 CSV 往返；", "交付 README.md。"])
        const inspection = history
          .flatMap((message) => (message.type === "assistant" ? message.content : []))
          .find((part) => part.type === "tool" && part.id === "inspect-original")
        expect(inspection).toMatchObject({
          state: {
            status: "completed",
            structured: {
              requirements: [
                { id: 1, text: "实现 CSV 往返；" },
                { id: 2, text: "交付 README.md。" },
              ],
            },
          },
        })
        expect(executions).toBe(1)
        expect(yield* session.outcome(sessionID)).toMatchObject({ state: "completed_unverified" })
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "解释一个新概念" }), resume: false })
        requests.length = 0
        responses = [stop]
        yield* session.resume(sessionID)
        expect(requests).toHaveLength(1)
        expect(SessionOutcome.requested(yield* SessionOutcome.history(database.db, sessionID)).clauses).toEqual([
          "解释一个新概念",
        ])
        expect(executions).toBe(1)
      }).pipe(
        Effect.provide(
          VerificationReviewTool.layer.pipe(
            Layer.provide(Layer.mock(PermissionV2.Service, { assert: () => Effect.void })),
          ),
        ),
      ),
  )

  it.effect("persists a real requirement review and keeps declared gaps unverified despite a done message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        bash: Tool.make({
          description: "Check",
          input: Schema.Struct({}),
          output: Schema.Struct({ exit: Schema.Number }),
          execute: () => Effect.succeed({ exit: 0 }),
        }),
      })
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "保留全部自有字符串键；失败不修改输入。" }),
        resume: false,
      })
      const call = (id: string, name: string, input: Record<string, unknown>) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id, name, input }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      const stop = fragmentFixture("text", "done", ["Done."]).completeEvents
      responses = [
        call("check", "bash", {}),
        stop,
        call("inspect-review", "verification_review", {}),
        call("submit-review", "verification_review", {
          items: [
            { requirement: 1, evidence: [], status: "unverified", note: "Non-enumerable keys not supported" },
            { requirement: 2, evidence: ["ev_not_a_check"], status: "unverified", note: "No current evidence" },
          ],
          unverified: ["Non-enumerable own keys are unsupported"],
        }),
        stop,
      ]
      yield* session.resume(sessionID)
      const messages = yield* session.context(sessionID)
      const inspect = messages
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((part) => part.type === "tool" && part.id === "inspect-review")
      expect(inspect).toMatchObject({
        state: {
          status: "completed",
          structured: {
            requirements: [
              { id: 1, text: "保留全部自有字符串键；" },
              { id: 2, text: "失败不修改输入。" },
            ],
          },
        },
      })
      const outcome = SessionOutcome.derive(messages, false)
      expect(outcome.state).toBe("completed_unverified")
      expect(outcome.review?.unverified).toEqual(["Non-enumerable own keys are unsupported"])
      expect(outcome.missing.join(" ")).toContain("declared unverified")
      const submit = messages
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((part) => part.type === "tool" && part.id === "submit-review")
      expect(submit).toMatchObject({
        state: {
          status: "completed",
          structured: { problems: [expect.stringContaining("ev_not_a_check is not a verification check callID")] },
        },
      })
    }).pipe(
      Effect.provide(
        VerificationReviewTool.layer.pipe(
          Layer.provide(
            Layer.mock(PermissionV2.Service, {
              assert: (input) =>
                Effect.sync(() => {
                  expect(input.action).toBe("verification_review")
                  expect(input.sessionID).toBe(sessionID)
                }),
            }),
          ),
        ),
      ),
    ),
  )

  it.effect("persists extra-scope notes without blocking current passing evidence", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        bash: Tool.make({
          description: "Check",
          input: Schema.Struct({}),
          output: Schema.Struct({ exit: Schema.Number, verification: Schema.Unknown }),
          execute: (_input, context) =>
            Effect.succeed({
              exit: 0,
              verification: {
                kind: "test",
                command: "node check.mjs",
                callID: context.toolCallID,
                exit: 0,
                targets: [{ path: "/src.js", digest: "fixed" }],
                requirements: ["all keys"],
              },
            }),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "保留全部自有字符串键。" }), resume: false })
      const call = (id: string, name: string, input: Record<string, unknown>) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id, name, input }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      const stop = fragmentFixture("text", "done", ["Done."]).completeEvents
      responses = [
        call("check", "bash", {}),
        stop,
        call("review", "verification_review", {
          items: [{ requirement: 1, evidence: ["check"], status: "verified", note: "All own string keys asserted" }],
          unverified: [],
          notes: [
            { text: "Other platforms not tested", requirements: [] },
            { text: "Symbol keys are outside the requested string-key contract", requirements: [1] },
          ],
        }),
        stop,
      ]
      yield* session.resume(sessionID)
      const messages = yield* session.context(sessionID)
      const outcome = SessionOutcome.derive(messages, false, undefined, [{ path: "/src.js", digest: "fixed" }], [])
      expect(outcome.state).toBe("completed_verified")
      expect(outcome.review?.notes).toEqual([
        { text: "Other platforms not tested", requirements: [] },
        { text: "Symbol keys are outside the requested string-key contract", requirements: [1] },
      ])
      expect(outcome.missing).toEqual([])
      const database = yield* Database.Service
      const durable = yield* SessionOutcome.history(database.db, sessionID)
      expect(SessionOutcome.derive(durable, false, undefined, [{ path: "/src.js", digest: "fixed" }], []).state).toBe(
        "completed_verified",
      )
    }).pipe(
      Effect.provide(
        VerificationReviewTool.layer.pipe(
          Layer.provide(
            Layer.mock(PermissionV2.Service, {
              assert: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  )

  it.effect("keeps the request prefix stable across successful and failed verification calls", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        bash: Tool.make({
          description: "Verification fixture",
          input: Schema.Struct({ command: Schema.String, exit: Schema.Number }),
          output: Schema.Struct({
            verification: Schema.Struct({
              kind: Schema.Literal("interaction"),
              command: Schema.String,
              exit: Schema.Number,
              callID: Schema.String,
            }),
          }),
          execute: (input, context) =>
            Effect.succeed({
              verification: {
                kind: "interaction" as const,
                command: input.command,
                exit: input.exit,
                callID: context.toolCallID,
              },
            }),
          toModelOutput: () => [{ type: "text", text: "Observed check output" }],
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Verify both checks" }), resume: false })
      requests.length = 0
      responses = [
        ...[1, 0].map((exit) => [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: `check-${exit}`, name: "bash", input: { command: `check-${exit}`, exit } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]),
        fragmentFixture("text", "done", ["One check remains failed."]).completeEvents,
        fragmentFixture("text", "reported", ["Cannot verify the remaining check."]).completeEvents,
      ]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(4)
      expect(requests[3]!.system).toEqual(requests[0]!.system)
      expect(JSON.stringify(requests[3]!.messages)).toContain("Verification closing review:")
      expect(requests[1]!.system).toEqual(requests[0]!.system)
      expect(requests[2]!.system).toEqual(requests[0]!.system)
      expect(requests[2]!.tools).toEqual(requests[0]!.tools)
      expect(requests[2]!.messages.slice(0, requests[1]!.messages.length)).toEqual([...requests[1]!.messages])
      expect(JSON.stringify(requests[2]!.messages)).toContain("Verification record")
      expect(SessionOutcome.derive(yield* session.context(sessionID), false)).toMatchObject({ state: "failed" })
    }),
  )

  it.effect("stops varied failed shell attempts with a final report instead of spending more tool turns", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        bash: Tool.make({
          description: "A shell failure fixture",
          input: Schema.Struct({ command: Schema.String }),
          output: Schema.Struct({}),
          execute: () => Effect.fail(new Tool.Failure({ message: "Command could not execute" })),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Verify the artifact" }), resume: false })
      requests.length = 0
      responses = [
        ...Array.from({ length: 4 }, (_, index) => [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: `failed-shell-${index}`, name: "bash", input: { command: `bad-command-${index}` } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      expect(requests).toHaveLength(5)
      expect(requests[4]!.tools).toEqual([])
      expect(requests[4]!.toolChoice).toMatchObject({ type: "none" })
      expect(JSON.stringify(requests[3]!.system)).toContain("Change approach")
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({ finish: "max-steps" })
      expect(yield* session.outcome(sessionID)).toMatchObject({ state: "failed", outcomeUnknown: false })
    }),
  )

  it.effect("returns policy-blocked tools to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        blocked: Tool.make({
          description: "Fail because policy blocked execution",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.BlockedError({ rules: [] })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Permission blocked" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call blocked" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-blocked", name: "blocked", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call blocked" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-blocked", state: { status: "error", error: { message: "Permission blocked" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("interrupts runner continuation when permission approval is declined", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        declined: Tool.make({
          description: "Fail because the user declined approval",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die(new PermissionV2.DeclinedError()),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call declined" }), resume: false })

      requests.length = 0
      executions.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-declined", name: "declined", input: {} }),
        LLMEvent.toolCall({ id: "call-after-decline", name: "echo", input: { text: "must not run" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(executions).toEqual([])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call declined" },
        {
          type: "assistant",
          finish: "interrupted",
          time: { completed: expect.anything() },
          content: [
            {
              type: "tool",
              id: "call-declined",
              state: { status: "error", error: { message: "Tool execution interrupted" } },
            },
            {
              type: "tool",
              id: "call-after-decline",
              state: { status: "error", error: { message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("returns permission corrections to the model and continues", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        corrected: Tool.make({
          description: "Fail with user correction feedback",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.CorrectedError({ feedback: "Use another tool" })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Use another tool" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call corrected" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-corrected", name: "corrected", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call corrected" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-corrected", state: { status: "error", error: { message: "Use another tool" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  it.effect("interrupts runner continuation when a question is dismissed", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      const questions = yield* QuestionV2.Service
      yield* registry.register({
        question: Tool.make({
          description: "Ask the user",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: (_, context) =>
            questions.ask({ sessionID: context.sessionID, questions: [] }).pipe(Effect.as({}), Effect.orDie),
        }),
      })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Ask then stop" }), resume: false })

      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-question", name: "question", input: {} }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [],
      ]

      const run = yield* session.resume(sessionID).pipe(Effect.exit, Effect.forkChild)
      let pending = yield* questions.list()
      while (pending.length === 0) {
        yield* Effect.yieldNow
        pending = yield* questions.list()
      }
      yield* questions.reject(pending[0]!.id)
      const exit = yield* Fiber.join(run)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then stop" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-question",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("awaits started local tools before surfacing provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Settle before failing" }), resume: false })
      const failure = providerUnavailable()
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-failure", name: "echo", input: { text: "settle" } }),
        ]),
        Stream.fail(failure),
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Deferred.succeed(toolExecutionGate, undefined)
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBe(failure)
      toolExecutionGate = undefined

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Settle before failing" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-before-failure", state: { status: "completed", structured: { text: "settle" } } },
          ],
        },
      ])
    }),
  )

  it.effect("durably fails blocked local tools when a provider turn is interrupted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt blocked tool" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-interrupt", name: "echo", input: { text: "blocked" } }),
        ]),
        Stream.never,
      )

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      yield* session.interrupt(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-before-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        { type: "assistant", content: [{ type: "tool", id: "call-before-interrupt", state: { status: "error" } }] },
      ])
      requests.length = 0
      responseStream = undefined
      response = []
      yield* session.resume(sessionID)
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    }),
  )

  it.effect("interrupts a blocked provider turn without local tool execution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt provider" }), resume: false })
      requests.length = 0
      response = []
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.interrupt(sessionID)
      const exit = yield* Fiber.await(run)
      streamGate = undefined
      streamStarted = undefined

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(requests).toHaveLength(1)
      yield* session.interrupt(sessionID)
    }),
  )

  it.effect("durably fails blocked local tools when interrupted while awaiting settlement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Interrupt tool settlement" }), resume: false })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-await-interrupt", name: "echo", input: { text: "blocked" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]

      const runner = yield* SessionRunner.Service
      const run = yield* runner.run({ sessionID, force: true }).pipe(Effect.forkChild)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* Fiber.interrupt(run)
      toolExecutionGate = undefined

      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt tool settlement" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-await-interrupt",
              state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  it.effect("preserves reported provider usage when interrupted during local tool settlement", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Interrupt after provider finish" }),
        resume: false,
      })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      const providerFinished = yield* Deferred.make<void>()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-usage-interrupt", name: "echo", input: { text: "blocked" } }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: {
              inputTokens: 120,
              nonCachedInputTokens: 20,
              cacheReadInputTokens: 100,
              outputTokens: 30,
              reasoningTokens: 10,
            },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]),
        Stream.fromEffect(Deferred.succeed(providerFinished, undefined)).pipe(Stream.drain),
      )
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(providerFinished)
      while (executions.length === 0) yield* Effect.yieldNow
      yield* session.interrupt(sessionID)
      toolExecutionGate = undefined
      expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({ finish: "interrupted" })
      expect((yield* SessionUsageQuery.read(sessionID)).total).toMatchObject({ total: 150, calls: 1, unreported: 0 })
      yield* session.interrupt(sessionID)
      yield* replaySessionProjection(sessionID)
      expect((yield* SessionUsageQuery.read(sessionID)).total).toMatchObject({ total: 150, calls: 1, unreported: 0 })
    }),
  )

  it.effect("increases a soft output budget within known capacity and stops repeated exhaustion", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = Model.make({
        id: "fake-model",
        provider: "fake",
        route: OpenAIChat.route.with({
          limits: { context: 200000, output: 64000 },
        }),
      })
      sessionOutput = { fake: { "fake-model": { initial: 16000, maximum: 64000 } } }
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Complete the change" }), resume: false })
      requests.length = 0
      response = reasoningLimitResponse()
      expect(Exit.isFailure(yield* session.resume(sessionID).pipe(Effect.exit))).toBe(true)
      expect(requests.map((request) => request.generation?.maxTokens)).toEqual([16000, 32000, 64000])
      expect(requests.every((request) => request.tools.length > 0)).toBe(true)
    }),
  )

  it.effect("respects explicit output ceilings even when a soft policy permits more", () =>
    Effect.gen(function* () {
      yield* setup
      currentModel = Model.make({
        id: "fake-model",
        provider: "fake",
        route: OpenAIChat.route.with({
          generation: { maxTokens: 16000 },
          limits: { context: 200000, output: 64000 },
        }),
      })
      sessionOutput = { fake: { "fake-model": { initial: 16000, maximum: 64000 } } }
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Complete the change" }), resume: false })
      requests.length = 0
      response = reasoningLimitResponse()
      expect(Exit.isFailure(yield* session.resume(sessionID).pipe(Effect.exit))).toBe(true)
      expect(requests.map((request) => request.generation?.maxTokens)).toEqual([16000, 16000])
    }),
  )

  it.effect("keeps tools available when an empty length response is recovered", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Complete the change" }), resume: false })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "length" }),
          LLMEvent.finish({ reason: "length" }),
        ],
        fragmentFixture("text", "done", ["Done."]).completeEvents,
      ]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
      expect(requests[1].tools.length).toBeGreaterThan(0)
      expect(requests[1].generation?.maxTokens).toBeUndefined()
    }),
  )

  it.effect("does not automatically retry an exhausted turn with provider-executed tools", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Complete the change" }), resume: false })
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "hosted", name: "search", input: {}, providerExecuted: true }),
        LLMEvent.stepFinish({ index: 0, reason: "length" }),
        LLMEvent.finish({ reason: "length" }),
      ]
      expect(Exit.isFailure(yield* session.resume(sessionID).pipe(Effect.exit))).toBe(true)
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("recovers reasoning exhaustion once with tools and accounts for both provider turns", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Build the requested game" }), resume: false })
      requests.length = 0
      executions.length = 0
      responses = [
        reasoningLimitResponse(),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "recovered-action", name: "echo", input: { text: "small action" } }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: { inputTokens: 20, nonCachedInputTokens: 20, outputTokens: 10 },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "stop",
            usage: { inputTokens: 10, nonCachedInputTokens: 10, outputTokens: 5 },
          }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(3)
      expect(requests[1].tools.some((tool) => tool.name === "echo")).toBe(true)
      expect(requests[1].toolChoice?.type).not.toBe("none")
      expect(requests[1].model).toEqual(requests[0].model)
      expect(requests[1].generation).toEqual(requests[0].generation)
      expect(userTexts(requests[1])).toContain("Build the requested game")
      expect(requests[1].system.some((part) => part.text.includes("Output recovery"))).toBe(true)
      expect(executions).toEqual(["small action"])
      expect((yield* SessionUsageQuery.read(sessionID)).total).toMatchObject({
        total: 16529,
        calls: 3,
        unreported: 0,
      })
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({ finish: "stop" })
      const database = yield* Database.Service
      const retries = yield* database.db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Retried.type, 1)))
        .all()
        .pipe(Effect.orDie)
      expect(retries).toHaveLength(1)
      expect(retries[0].data).toMatchObject({
        attempt: 1,
        error: {
          metadata: {
            phase: "reasoning-exhaustion",
            category: "length",
            reasoningTokens: "16384",
          },
        },
      })
    }),
  )

  it.effect("does not reset reasoning recovery after compaction, replay or a new drain; new input gets one", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First task" }), resume: false })
      requests.length = 0
      response = reasoningLimitResponse()
      expect(Exit.isFailure(yield* session.resume(sessionID).pipe(Effect.exit))).toBe(true)
      expect(requests).toHaveLength(2)
      const messageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        reason: "manual",
        text: "Prior task",
        recent: "",
      })
      yield* replaySessionProjection(sessionID)
      requests.length = 0
      expect(Exit.isFailure(yield* session.resume(sessionID).pipe(Effect.exit))).toBe(true)
      expect(requests).toHaveLength(1)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "New task" }), resume: false })
      requests.length = 0
      expect(Exit.isFailure(yield* session.resume(sessionID).pipe(Effect.exit))).toBe(true)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("renews output recovery only after host-observed file changes", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const database = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Complete the change" }), resume: false })
      response = reasoningLimitResponse()
      yield* session.resume(sessionID).pipe(Effect.exit)
      expect((yield* SessionOutputRecovery.read(database.db, sessionID)).attempts.get("reasoning-exhaustion")).toBe(1)
      const row = yield* database.db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(
          eq(
            EventTable.type,
            EventV2.versionedType(SessionEvent.Step.Ended.type, SessionEvent.Step.Ended.durable?.version ?? 1),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      const step = Schema.decodeUnknownSync(SessionEvent.Step.Ended.data)(row!.data)
      yield* events.publish(SessionEvent.Step.Ended, { ...step, finish: "stop", files: [] })
      expect((yield* SessionOutputRecovery.read(database.db, sessionID)).attempts.get("reasoning-exhaustion")).toBe(1)
      yield* events.publish(
        SessionEvent.Step.Ended,
        Schema.decodeUnknownSync(SessionEvent.Step.Ended.data)({
          ...row!.data,
          finish: "tool-calls",
          files: ["changed.ts"],
        }),
      )
      expect((yield* SessionOutputRecovery.read(database.db, sessionID)).attempts.size).toBe(0)
      yield* replaySessionProjection(sessionID)
      expect((yield* SessionOutputRecovery.read(database.db, sessionID)).attempts.size).toBe(0)
    }),
  )

  it.effect("keeps the existing text continuation allowance separate from reasoning recovery", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Explain the result" }), resume: false })
      requests.length = 0
      responses = [
        reasoningLimitResponse(),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "answer" }),
          LLMEvent.textDelta({ id: "answer", text: "Partial answer" }),
          LLMEvent.textEnd({ id: "answer" }),
          LLMEvent.stepFinish({ index: 0, reason: "length" }),
          LLMEvent.finish({ reason: "length" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(3)
      expect(requests[1].toolChoice?.type).not.toBe("none")
      expect(requests[2].toolChoice?.type).toBe("none")
      expect(requests[2].tools).toEqual([])
      expect(JSON.stringify(requests[2].messages)).toContain("Partial answer")
    }),
  )

  for (const partial of [false, true]) {
    it.effect(`retains ${partial ? "partial tool rejection" : "completed tool result"} during output recovery`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Work safely" }), resume: false })
        requests.length = 0
        executions.length = 0
        response = reasoningLimitResponse()
        response.splice(
          4,
          0,
          ...(partial
            ? [
                LLMEvent.toolInputStart({ id: "partial-reasoning-tool", name: "echo" }),
                LLMEvent.toolInputDelta({ id: "partial-reasoning-tool", name: "echo", text: '{"text":' }),
              ]
            : [LLMEvent.toolCall({ id: "reasoning-tool", name: "echo", input: { text: "execute once" } })]),
        )
        responses = [
          response,
          [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id: "next-action", name: "echo", input: { text: "next action" } }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ],
          fragmentFixture("text", "finished", ["Done."]).completeEvents,
        ]
        yield* session.resume(sessionID)
        expect(requests).toHaveLength(3)
        expect(requests[1].tools.length).toBeGreaterThan(0)
        expect(JSON.stringify(requests[1].messages)).toContain(partial ? "not executed" : "execute once")
        expect(executions).toEqual(partial ? ["next action"] : ["execute once", "next action"])
      }),
    )
  }

  it.effect("can cancel the reasoning recovery provider turn without another automatic attempt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Cancelable task" }), resume: false })
      requests.length = 0
      executions.length = 0
      response = reasoningLimitResponse()
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      yield* events.listen((event) =>
        event.type === SessionEvent.Retried.type
          ? Effect.sync(() => {
              streamGate = gate
              streamStarted = started
            })
          : Effect.void,
      )
      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* session.interrupt(sessionID)
      expect(Exit.isFailure(yield* Fiber.await(run))).toBe(true)
      expect(requests).toHaveLength(2)
      expect(executions).toEqual([])
      streamGate = undefined
      streamStarted = undefined
      requests.length = 0
      expect(Exit.isFailure(yield* session.resume(sessionID).pipe(Effect.exit))).toBe(true)
      expect(requests).toHaveLength(1)
    }),
  )

  it.effect("does not recover reasoning exhaustion beyond the configured provider-turn limit", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 1
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Bounded task" }), resume: false })
      requests.length = 0
      response = reasoningLimitResponse()
      expect(Exit.isFailure(yield* session.resume(sessionID).pipe(Effect.exit))).toBe(true)
      expect(requests).toHaveLength(1)
    }),
  )

  for (const reason of ["content-filter", "error", "unknown"] as const) {
    it.effect(`does not treat reasoning followed by ${reason} as output exhaustion`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Do the task" }), resume: false })
        requests.length = 0
        response = [
          ...reasoningLimitResponse().slice(0, 4),
          LLMEvent.stepFinish({ index: 0, reason }),
          LLMEvent.finish({ reason }),
        ]
        expect(Exit.isFailure(yield* session.resume(sessionID).pipe(Effect.exit))).toBe(true)
        expect(requests).toHaveLength(1)
      }),
    )
  }

  for (const reason of ["length", "content-filter", "error", "unknown"] as const) {
    it.effect(`records ${reason} as incomplete instead of successful completion`, () =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Finish the change" }), resume: false })
        requests.length = 0
        response = [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "partial" }),
          LLMEvent.textDelta({ id: "partial", text: "I have started" }),
          LLMEvent.textEnd({ id: "partial" }),
          LLMEvent.stepFinish({ index: 0, reason }),
          LLMEvent.finish({ reason }),
        ]
        const exit = yield* session.resume(sessionID).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(requests).toHaveLength(reason === "length" ? 2 : 1)
        expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
          type: "assistant",
          finish: "error",
          error: { message: expect.any(String) },
        })
      }),
    )
  }

  it.effect("preserves partial output and records an unfinished provider stream as failed", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Finish the change" }), resume: false })
      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "partial" }),
        LLMEvent.textDelta({ id: "partial", text: "Partial result" }),
      ]
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      expect(requests).toHaveLength(1)
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
        finish: "error",
        error: { message: "Provider stream ended without completing the turn" },
        content: [{ type: "text", text: "Partial result" }],
      })
    }),
  )

  it.effect("warns once near the session budget in model history without changing the system prefix", () =>
    Effect.gen(function* () {
      yield* setup
      sessionTokenBudget = 1000
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Finish the bounded task" }), resume: false })
      requests.length = 0
      responses = [750, 20, 20].map((tokens, index) => [
        LLMEvent.stepStart({ index: 0 }),
        ...(index < 2
          ? [LLMEvent.toolCall({ id: `notice-${index}`, name: "echo", input: { text: `step-${index}` } })]
          : []),
        LLMEvent.stepFinish({
          index: 0,
          reason: index < 2 ? "tool-calls" : "stop",
          usage: { inputTokens: tokens, nonCachedInputTokens: tokens, outputTokens: 0 },
        }),
        LLMEvent.finish({ reason: index < 2 ? "tool-calls" : "stop" }),
      ])
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(3)
      expect(requests[1].system).toEqual(requests[0].system)
      expect(JSON.stringify(requests[0].messages)).not.toContain("Session token budget notice")
      expect(JSON.stringify(requests[1].messages)).toContain("Session token budget notice (limit=1000)")
      expect(JSON.stringify(requests[1].messages)).toContain("250")
      const notices = (yield* session.context(sessionID)).filter(
        (message) => message.type === "synthetic" && message.text.startsWith("Session token budget notice"),
      )
      expect(notices).toHaveLength(1)
      expect((yield* SessionUsageQuery.read(sessionID)).total).toMatchObject({ total: 790, calls: 3, unreported: 0 })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Report the current result" }), resume: false })
      responses = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "stop",
          usage: { inputTokens: 10, nonCachedInputTokens: 10, outputTokens: 0 },
        }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      expect(
        (yield* session.context(sessionID)).filter(
          (message) => message.type === "synthetic" && message.text.startsWith("Session token budget notice"),
        ),
      ).toHaveLength(1)
    }),
  )

  it.effect("settles tools before budget stop, does not bill the notice, and keeps the limit on resume", () =>
    Effect.gen(function* () {
      yield* setup
      sessionTokenBudget = 100
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Budgeted task" }), resume: false })
      requests.length = 0
      executions.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "budget-tool", name: "echo", input: { text: "retained" } }),
        LLMEvent.stepFinish({
          index: 0,
          reason: "tool-calls",
          usage: {
            inputTokens: 100,
            nonCachedInputTokens: 20,
            cacheReadInputTokens: 80,
            outputTokens: 20,
            reasoningTokens: 5,
          },
        }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ]
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      expect(requests).toHaveLength(1)
      expect(executions).toEqual(["retained"])
      const context = yield* session.context(sessionID)
      expect(context.at(-1)).toMatchObject({
        finish: "budget-exhausted",
        content: [{ text: expect.stringContaining("达到配置预算 100") }],
      })
      expect(SessionOutcome.derive(context, false)).toMatchObject({ state: "failed", outcomeUnknown: false })
      expect((yield* SessionUsageQuery.read(sessionID)).total).toMatchObject({ total: 120, calls: 1, unreported: 0 })
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toHaveLength(context.length)
      // A fresh prompt does not reset the cumulative session budget.
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Continue" }), resume: false })
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      expect(requests).toHaveLength(1)
      sessionTokenBudget = 300
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]
      yield* session.resume(sessionID)
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect("counts durable compaction usage before ordinary requests and manual compaction", () =>
    Effect.gen(function* () {
      yield* setup
      sessionTokenBudget = 100
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Compacted task" }), resume: false })
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Compaction.Failed, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        reason: "auto",
        sourceSequence: 0,
        error: { type: "unknown", message: "summary failed" },
        usage: {
          providerID: "fake",
          reported: true,
          tokens: { input: 80, output: 20, reasoning: 10, cache: { read: 0, write: 0 } },
        },
      })
      requests.length = 0
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      expect(requests).toHaveLength(0)
      const runner = yield* SessionRunner.Service
      expect(yield* runner.compact(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      expect(requests).toHaveLength(0)
      expect((yield* SessionUsageQuery.read(sessionID)).total).toMatchObject({ total: 110, calls: 1 })
    }),
  )

  it.effect("forces a text response on an agent's configured final step", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Finish at the limit" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-terminal", name: "echo", input: { text: "done" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-forbidden", name: "echo", input: { text: "forbidden" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ]

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)

      expect(requests).toHaveLength(2)
      expect(requests[0]?.toolChoice).toBeUndefined()
      expect(requests[1]?.toolChoice).toMatchObject({ type: "none" })
      expect(requests[1]?.tools).toEqual([])
      expect(requests[1]?.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
      })
      expect(executions).toEqual(["done"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Finish at the limit" },
        { type: "assistant", content: [{ type: "tool", id: "call-terminal", state: { status: "completed" } }] },
        {
          type: "assistant",
          finish: "max-steps",
          content: [{ type: "tool", id: "call-forbidden", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("blocks repeated identical tool side effects after three attempts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Do not loop forever" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = Array.from({ length: 4 }, (_, index) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: `call-repeat-${index}`, name: "echo", input: { text: "same" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])

      yield* session.resume(sessionID)

      expect(executions).toEqual(["same", "same", "same"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Do not loop forever" },
        { type: "assistant", content: [{ type: "tool", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "tool", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "tool", state: { status: "completed" } }] },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              state: {
                status: "error",
                error: { message: expect.stringContaining("Identical tool call blocked after 3 attempts") },
              },
            },
          ],
        },
      ])
    }),
  )

  it.effect("stops a repeated tool loop after one corrective response", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Avoid a loop" }), resume: false })
      requests.length = 0
      executions.length = 0
      responses = Array.from({ length: 6 }, (_, index) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: `repeat-${index}`,
          name: "echo",
          input: index % 2 ? { text: "same", extra: 1 } : { extra: 1, text: "same" },
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      expect(requests).toHaveLength(5)
      expect(executions).toEqual(["same", "same", "same"])
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
        finish: "error",
        error: { message: expect.stringContaining("repeated identical tool calls") },
      })
    }),
  )

  it.effect("enforces the turn budget even when the final call repeats a blocked tool", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((draft) =>
        draft.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 5
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Respect the budget" }), resume: false })
      requests.length = 0
      executions.length = 0
      responses = Array.from({ length: 7 }, (_, index) => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: `budget-${index}`, name: "echo", input: { text: "same" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      expect(requests).toHaveLength(5)
      expect(executions).toHaveLength(3)
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({ finish: "max-steps" })
    }),
  )

  it.effect("allows repeated verification after edits and checks the updated file in declaration order", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* setup
          const file = `${tmp.path}/value.txt`
          yield* Effect.promise(() => Bun.write(file, "0"))
          const registry = yield* ToolRegistry.Service
          const observations: string[] = []
          yield* registry.register({
            change: Tool.make({
              description: "Change the fixture",
              input: Schema.Struct({ value: Schema.String }),
              output: Schema.String,
              execute: (input) => Effect.promise(() => Bun.write(file, input.value)).pipe(Effect.as("written")),
            }),
            verify: Tool.make({
              description: "Read the fixture",
              input: Schema.Struct({}),
              output: Schema.String,
              execute: () =>
                Effect.promise(() => Bun.file(file).text()).pipe(
                  Effect.tap((text) =>
                    Effect.sync(() => {
                      observations.push(text)
                    }),
                  ),
                ),
            }),
          })
          const session = yield* SessionV2.Service
          yield* session.prompt({
            sessionID,
            prompt: Prompt.make({ text: "Edit and verify repeatedly" }),
            resume: false,
          })
          requests.length = 0
          responses = Array.from({ length: 5 }, (_, index) => [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id: `change-${index}`, name: "change", input: { value: String(index + 1) } }),
            LLMEvent.toolCall({ id: `verify-${index}`, name: "verify", input: {} }),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ])
          responses.push(fragmentFixture("text", "done", ["Verified five edits."]).completeEvents)
          yield* session.resume(sessionID)
          expect(observations).toEqual(["1", "2", "3", "4", "5"])
          expect(requests).toHaveLength(6)
          expect((yield* session.context(sessionID)).at(-1)).toMatchObject({ finish: "stop" })
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.effect("resets the configured step allowance when steering input promotes", () =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Start work" }), resume: false })

      requests.length = 0
      executions.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-steer", name: "echo", input: { text: "before" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-after-steer", name: "echo", input: { text: "after" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      streamGate = yield* Deferred.make<void>()
      streamStarted = yield* Deferred.make<void>()

      const run = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(streamStarted)
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Change direction" }) })
      yield* Deferred.succeed(streamGate, undefined)
      expect(yield* Fiber.join(run).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      streamGate = undefined
      streamStarted = undefined

      expect(requests).toHaveLength(3)
      expect(requests[1]?.toolChoice).toBeUndefined()
      expect(requests[1]?.tools).not.toEqual([])
      expect(requests[2]?.toolChoice).toMatchObject({ type: "none" })
      expect(executions).toEqual(["before", "after"])
    }),
  )

  it.effect("projects provider errors as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail durably" }), resume: false })

      requests.length = 0
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "Provider unavailable" })]

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("projects provider errors emitted before assistant step start", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail before step" }), resume: false })

      requests.length = 0
      response = [LLMEvent.providerError({ message: "Provider unavailable" })]

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail before step" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("does not recover context overflow after durable assistant output", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail after output" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-partial" }),
        LLMEvent.textDelta({ id: "text-partial", text: "Partial" }),
        LLMEvent.textEnd({ id: "text-partial" }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail after output" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
    }),
  )

  it.effect("projects raw provider stream failures as terminal assistant step failures", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail raw stream durably" }), resume: false })
      const failure = providerUnavailable()
      responseStream = Stream.fail(failure)

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail raw stream durably" },
        { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  it.effect("does not continue automatically after a provider error follows a local tool call", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do not continue failed provider" }),
        resume: false,
      })

      requests.length = 0
      const executionCount = executions.length
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-before-provider-error", name: "echo", input: { text: "settled" } }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)

      expect(requests).toHaveLength(1)
      expect(executions.slice(executionCount)).toEqual(["settled"])
    }),
  )

  it.effect("durably fails a hosted tool when its provider errors before returning a result", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail hosted tool durably" }), resume: false })

      requests.length = 0
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-provider-error",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
        LLMEvent.providerError({ message: "Provider unavailable" }),
      ]

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)

      expect(requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool durably" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-hosted-provider-error", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved at normal provider EOF", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fail hosted tool at EOF" }), resume: false })
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({
          id: "call-hosted-eof",
          name: "web_search",
          input: { query: "effect" },
          providerExecuted: true,
        }),
      ]

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool at EOF" },
        { type: "assistant", content: [{ type: "tool", id: "call-hosted-eof", state: { status: "error" } }] },
      ])
    }),
  )

  it.effect("durably fails a hosted tool left unresolved by a raw provider stream failure", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fail hosted tool on raw failure" }),
        resume: false,
      })
      const failure = providerUnavailable()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hosted-raw-failure",
            name: "web_search",
            input: { query: "effect" },
            providerExecuted: true,
          }),
        ]),
        Stream.fail(failure),
      )

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool on raw failure" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          content: [{ type: "tool", id: "call-hosted-raw-failure", state: { status: "error" } }],
        },
      ])
    }),
  )

  it.effect("settles local input-only calls when the provider stream fails before tool execution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Reject invalid tool JSON" }), resume: false })
      const failure = providerUnavailable()
      responseStream = Stream.concat(
        Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolInputStart({ id: "call-invalid-json", name: "write" }),
          LLMEvent.toolInputDelta({ id: "call-invalid-json", name: "write", text: '{"path":' }),
        ]),
        Stream.fail(failure),
      )
      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          finish: "error",
          content: [{ type: "tool", id: "call-invalid-json", state: { status: "error" } }],
        },
      ])
      expect(yield* session.outcome(sessionID)).toMatchObject({ state: "failed", outcomeUnknown: false })
    }),
  )

  it.effect("keeps interleaved assistant text blocks separate", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Two blocks" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "text-1" }),
        LLMEvent.textStart({ id: "text-2" }),
        LLMEvent.textDelta({ id: "text-1", text: "First" }),
        LLMEvent.textDelta({ id: "text-2", text: "Second" }),
        LLMEvent.textEnd({ id: "text-1" }),
        LLMEvent.textEnd({ id: "text-2" }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ]

      yield* session.resume(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Two blocks" },
        {
          type: "assistant",
          content: [
            { type: "text", id: "text-1", text: "First" },
            { type: "text", id: "text-2", text: "Second" },
          ],
        },
      ])
    }),
  )

  for (const kind of fragmentKinds) {
    it.effect(`broadcasts provider ${kind} deltas without storing projection rewrites`, () =>
      verifyEphemeralDeltas(kind),
    )

    it.effect(`durably closes partial ${kind} when the provider stream fails`, () => verifyPartialFlushOnFailure(kind))

    it.effect(`durably closes partial ${kind} when the provider stream is interrupted`, () =>
      verifyPartialFlushOnInterruption(kind),
    )
  }

  it.effect("rejects duplicate streamed text starts", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.textStart({ id: "text-1" }), LLMEvent.textStart({ id: "text-1" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Duplicate text start: text-1",
      )
    }),
  )

  it.effect("transitions streamed raw tool input to parsed called input", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Call provider tool" }), resume: false })

      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolInputDelta({ id: "call-parsed", name: "web_search", text: '{"query":"hello"}' }),
        LLMEvent.toolInputEnd({ id: "call-parsed", name: "web_search" }),
        LLMEvent.toolCall({ id: "call-parsed", name: "web_search", input: { query: "hello" }, providerExecuted: true }),
      ]

      expect(yield* session.resume(sessionID).pipe(Effect.flip)).toBeInstanceOf(LLMError)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call provider tool" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-parsed", state: { status: "error", input: { query: "hello" } } }],
        },
      ])
    }),
  )

  it.effect("rejects malformed streamed tool input ordering", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      responses = undefined
      streamGate = undefined
      streamStarted = undefined
      response = [LLMEvent.toolInputDelta({ id: "call-1", name: "read", text: "{}" })]

      expect(yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed))).toBe(
        "Tool input delta before start: call-1",
      )
    }),
  )
})
