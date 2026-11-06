import { expect } from "bun:test"
import { Effect, Layer, Schema, Stream } from "effect"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@zaovra-ai/llm"
import { route } from "@zaovra-ai/llm/protocols/openai-chat"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { makeLocationNode } from "../src/effect/app-node"
import { LayerNode } from "../src/effect/layer-node"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { ToolRegistry } from "../src/tool/registry"
import { ToolSearch } from "../src/tool/tool-search"
import { Tool } from "../src/tool/tool"
import { ApplicationTools } from "../src/tool/application-tools"
import { BrowserTool } from "../src/tool/browser"
import { Database } from "../src/database/database"
import { EventTable } from "../src/event/sql"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionRunner } from "../src/session/runner/index"
import { SessionRunCoordinator } from "../src/session/run-coordinator"
import { node } from "../src/session/runner/llm"
import { SessionRunnerModel } from "../src/session/runner/model"
import { SessionProjector } from "../src/session/projector"
import { SessionStore } from "../src/session/store"
import { PluginV2 } from "../src/plugin"
import { Snapshot } from "../src/snapshot"
import { Location } from "../src/location"
import { PermissionV2 } from "../src/permission"
import { Config } from "../src/config"
import { ConfigExperimental } from "../src/config/experimental"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
const requests: LLMRequest[] = []
const executed: string[] = []
let scripted: LLMEvent[][] | undefined
const model = Model.make({ id: "gpt-6-luna", provider: "offline", route })
const client = Layer.mock(LLMClient.Service, {
  stream: (request: LLMRequest) => {
    requests.push(request)
    if (scripted) return Stream.fromIterable(scripted.shift() ?? [])
    const call =
      requests.length === 1
        ? { id: "discover", name: "tool_search", input: { names: ["browser"] } }
        : requests.length === 2
          ? { id: "inspect", name: "browser", input: {} }
          : undefined
    return Stream.fromIterable<LLMEvent>(
      call
        ? [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall(call),
            LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ]
        : [
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "done" }),
            LLMEvent.textDelta({ id: "done", text: "Observed fixture result." }),
            LLMEvent.textEnd({ id: "done" }),
            LLMEvent.stepFinish({ index: 0, reason: "stop" }),
            LLMEvent.finish({ reason: "stop" }),
          ],
    )
  },
})
const leaves = makeLocationNode({
  name: "test/profile-runner-leaves",
  deps: [ToolRegistry.node],
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      for (const name of ["apply_patch", "edit", "write", "browser", "read"])
        yield* registry.register({
          [name]: Tool.make({
            description: "Fixture " + name,
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () =>
              Effect.sync(() => {
                executed.push(name)
                return "retained result"
              }),
          }),
        })
    }),
  ),
})
const replacements: LayerNode.Replacements = [
  [Location.node, tempLocationLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
  [PluginV2.node, Layer.mock(PluginV2.Service, { wait: () => Effect.void })],
  [Snapshot.node, Snapshot.noopLayer],
  [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
  [
    Config.node,
    Layer.succeed(
      Config.Service,
      Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: new Config.Info({
                experimental: new ConfigExperimental.Experimental({
                  verification: false,
                  delivery_contract: false,
                  quality_progress: { facts: false, stagnation_log: false },
                }),
              }),
            }),
          ]),
      }),
    ),
  ],
]
const runtime = AppNodeBuilder.build(
  LayerNode.group([node, ToolSearch.node, ToolRegistry.node, leaves, Location.node]),
  replacements,
)
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const runner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => runner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      exclusive: coordinator.exclusive,
      wait: coordinator.wait,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
      freezeWake: coordinator.freezeWake,
      prepareWake: coordinator.prepareWake,
    })
  }),
).pipe(Layer.provide(runtime))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionV2.node,
      SessionProjector.node,
      SessionStore.node,
      node,
      ToolSearch.node,
      ToolRegistry.node,
      ApplicationTools.node,
      Database.node,
      leaves,
      Location.node,
    ]),
    replacements.concat([[SessionExecution.node, execution]]),
  ),
)
it.live("GPT runner persists discovery, advertises it next turn and keeps it on explicit continuation", () =>
  Effect.gen(function* () {
    scripted = undefined
    requests.length = 0
    executed.length = 0
    const sessions = yield* SessionV2.Service
    const location = yield* Location.Service
    const session = yield* sessions.create({ location: { directory: location.directory } })
    yield* sessions.prompt({ sessionID: session.id, prompt: { text: "Inspect the fixture workspace." }, resume: false })
    yield* sessions.resume(session.id)
    expect(requests).toHaveLength(3)
    expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain("browser")
    expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain("write")
    expect(requests[1]!.tools.map((tool) => tool.name)).toContain("browser")
    expect(executed).toEqual(["browser"])
    const transcript = yield* sessions.context(session.id)
    expect(
      transcript.flatMap((message) =>
        message.type === "assistant"
          ? message.content.filter((part) => part.type === "tool" && part.name === "tool_search")
          : [],
      ),
    ).toMatchObject([{ state: { status: "completed", structured: { activated: ["browser"] } } }])
    yield* sessions.prompt({
      sessionID: session.id,
      prompt: { text: "Continue with the retained result." },
      resume: false,
    })
    yield* sessions.resume(session.id)
    expect(requests).toHaveLength(4)
    expect(requests[3]!.tools.map((tool) => tool.name)).toContain("browser")
    expect(executed).toEqual(["browser"])
  }),
)

for (const partial of [false, true])
  it.live(
    `481 discovery preserves custom tools and local recovery before remote ${partial ? "partial" : "unknown"} gate`,
    () =>
      Effect.gen(function* () {
        requests.length = 0
        executed.length = 0
        const sessions = yield* SessionV2.Service
        const location = yield* Location.Service
        const applications = yield* ApplicationTools.Service
        const registry = yield* ToolRegistry.Service
        const database = yield* Database.Service
        const inspection = Tool.make({
          description: "Application inspection of a retained local error",
          effectLocation: "local",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () =>
            Effect.sync(() => {
              executed.push("inspect")
              return "retained local error inspected without repeating the edit"
            }),
        })
        yield* applications.register({ write: inspection })
        yield* registry.register({
          write: inspection,
          edit: Tool.make({
            description: "Local edit with a returned partial result",
            effectLocation: "local",
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () =>
              Effect.sync(() => executed.push("edit")).pipe(
                Effect.andThen(
                  Effect.fail(
                    new Tool.Failure({
                      message: "Local partial result; inspect before another edit.",
                      metadata: { phase: "mutation", reason: "partial-application" },
                    }),
                  ),
                ),
              ),
          }),
          browser: Tool.make({
            description: "Remote action with an unconfirmed observation",
            effectLocation: "remote",
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () =>
              Effect.sync(() => executed.push("browser")).pipe(
                Effect.andThen(
                  Effect.fail(
                    BrowserTool.failure(
                      "remote observation lost",
                      !partial,
                      partial ? [{ status: "executed" }, { status: "not_executed" }] : [],
                    ),
                  ),
                ),
              ),
          }),
        })
        const call = (id: string, name: string, input: Record<string, unknown> = {}) => [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id, name, input }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ]
        scripted = [
          call("481-discover", "tool_search", { names: ["edit", "browser"] }),
          call("481-local", "edit"),
          call("481-inspect", "write"),
          call("481-remote", "browser"),
          call("481-new-call-id", "browser"),
        ]
        const session = yield* sessions.create({ location: { directory: location.directory } })
        yield* sessions.prompt({ sessionID: session.id, prompt: { text: "Inspect the fixture once." }, resume: false })
        expect((yield* sessions.resume(session.id).pipe(Effect.exit))._tag).toBe("Failure")
        expect(requests).toHaveLength(4)
        expect(requests[0]!.tools.map((tool) => tool.name)).toContain("write")
        expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain("edit")
        expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain("browser")
        expect(requests[1]!.tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["edit", "browser", "write"]),
        )
        expect(JSON.stringify(requests[2]!.messages)).toContain("Local partial result")
        expect(executed).toEqual(["edit", "inspect", "browser"])
        const ledger = yield* database.db.select().from(EventTable).all().pipe(Effect.orDie)
        expect(
          ledger.some(
            (row) =>
              row.data.category === "operation" &&
              (row.data.details as Record<string, unknown>).callID === "481-local" &&
              (row.data.details as Record<string, unknown>).status === "settled",
          ),
        ).toBe(true)
        expect(
          ledger.some(
            (row) =>
              row.data.category === "operation" &&
              (row.data.details as Record<string, unknown>).callID === "481-remote" &&
              (row.data.details as Record<string, unknown>).status === "unknown",
          ),
        ).toBe(true)
        expect(
          (yield* sessions.context(session.id)).flatMap((message) =>
            message.type === "assistant"
              ? message.content.filter((part) => part.type === "tool" && part.name === "tool_search")
              : [],
          ),
        ).toMatchObject([{ state: { status: "completed", structured: { activated: ["browser", "edit"] } } }])
        yield* sessions.prompt({ sessionID: session.id, prompt: { text: "continue" }, resume: false })
        yield* sessions.resume(session.id)
        expect(requests).toHaveLength(4)
        expect(executed).toEqual(["edit", "inspect", "browser"])
        expect(scripted).toHaveLength(1)
      }),
  )

for (const id of ["deepseek-v4.1-flash-1017", "qwen3.7-flash", "glm-5.3-flash"]) {
  const nonGPT = testEffect(
    AppNodeBuilder.build(
      LayerNode.group([SessionV2.node, node, ToolSearch.node, ToolRegistry.node, leaves, Location.node]),
      replacements
        .filter(([key]) => key !== SessionRunnerModel.node)
        .concat([
          [
            SessionRunnerModel.node,
            SessionRunnerModel.layerWith(() => Effect.succeed(Model.make({ id, provider: "offline", route }))),
          ],
          [SessionExecution.node, SessionExecution.noopLayer],
        ]),
    ),
  )
  nonGPT.live("664 " + id + " discovers and executes a deferred tool, then retains it on continuation", () =>
    Effect.gen(function* () {
      scripted = undefined
      requests.length = 0
      executed.length = 0
      const sessions = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      const location = yield* Location.Service
      const session = yield* sessions.create({ location: { directory: location.directory } })
      yield* sessions.prompt({
        sessionID: session.id,
        prompt: { text: "Inspect the fixture workspace." },
        resume: false,
      })
      yield* runner.run({ sessionID: session.id, force: false })
      expect(requests).toHaveLength(3)
      expect(requests[0]!.tools.map((tool) => tool.name)).toContain("tool_search")
      expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain("browser")
      expect(requests[1]!.tools.map((tool) => tool.name)).toContain("browser")
      expect(executed).toEqual(["browser"])
      const transcript = yield* sessions.context(session.id)
      expect(
        transcript.flatMap((message) =>
          message.type === "assistant"
            ? message.content.filter((part) => part.type === "tool" && part.name === "tool_search")
            : [],
        ),
      ).toMatchObject([{ state: { status: "completed", structured: { activated: ["browser"] } } }])
      yield* sessions.prompt({
        sessionID: session.id,
        prompt: { text: "Continue with the retained result." },
        resume: false,
      })
      yield* runner.run({ sessionID: session.id, force: false })
      expect(requests).toHaveLength(4)
      expect(requests[3]!.tools.map((tool) => tool.name)).toContain("browser")
      expect(executed).toEqual(["browser"])
    }),
  )
}
