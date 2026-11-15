import { expect, test } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Layer, Schema, Stream } from "effect"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@zaovra-ai/llm"
import { OpenAIChat } from "@zaovra-ai/llm/protocols/openai-chat"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { Config } from "../src/config"
import { ConfigExperimental } from "../src/config/experimental"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { MemoryTidy } from "../src/memory/tidy"
import { MemoryTidyStore } from "../src/memory/tidy-store"
import { MemoryTidyExecution } from "../src/memory/tidy-execution"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { PermissionV2 } from "../src/permission"
import { PluginV2 } from "../src/plugin"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionRunner } from "../src/session/runner/index"
import { node } from "../src/session/runner/llm"
import { SessionRunnerModel } from "../src/session/runner/model"
import { Snapshot } from "../src/snapshot"
import { Tool } from "../src/tool/tool"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

const selected = { id: ModelV2.ID.make("tidy-fixture"), providerID: ProviderV2.ID.make("offline") }
const model = Model.make({ id: selected.id, provider: selected.providerID, route: OpenAIChat.route })
for (const boundary of ["active", "cancelled", "disabled", "model", "remote", "custom", "queued", "ordinary"] as const)
  test(`runner enforces tidy tool restrictions at actual dispatch: ${boundary}`, async () => {
    await using tmp = await tmpdir()
    const requests: LLMRequest[] = []
    const executed: string[] = []
    const names = boundary === "queued" ? ["read", "grep"] : ["read", "bash", "task", "write", "memory_note"]
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const state = {
      enabled: true,
      run: undefined as MemoryTidyStore.Run | undefined,
      before: Effect.void,
    }
    const client = Layer.mock(LLMClient.Service, {
      stream: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            requests.push(request)
            if (requests.length > 1)
              return Stream.fromIterable<LLMEvent>([
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.textStart({ id: "done" }),
                LLMEvent.textDelta({ id: "done", text: "Fixture review finished." }),
                LLMEvent.textEnd({ id: "done" }),
                LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                LLMEvent.finish({ reason: "stop" }),
              ])
            // Change authority after definitions were captured, before the
            // provider emits calls. Filtering the request alone cannot pass.
            yield* state.before
            return Stream.fromIterable<LLMEvent>([
              LLMEvent.stepStart({ index: 0 }),
              ...names.map((name) => LLMEvent.toolCall({ id: `call-${name}`, name, input: {} })),
              LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
              LLMEvent.finish({ reason: "tool-calls" }),
            ]).pipe(
              Stream.concat(
                boundary === "queued"
                  ? Stream.fromEffect(
                      Effect.gen(function* () {
                        yield* Deferred.await(entered)
                        state.enabled = false
                        yield* Deferred.succeed(release, undefined)
                      }),
                    ).pipe(Stream.drain)
                  : Stream.empty,
              ),
            )
          }),
        ),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const applications = yield* ApplicationTools.Service
        const definitions = Object.fromEntries(
          names.map((name) => [
            name,
            Tool.make({
              description: `Fixture ${name}`,
              effectLocation: boundary === "remote" ? "remote" : "local",
              input: Schema.Struct({}),
              output: Schema.String,
              execute: () =>
                Effect.gen(function* () {
                  executed.push(name)
                  if (boundary === "queued" && name === "read") {
                    yield* Deferred.succeed(entered, undefined)
                    yield* Deferred.await(release)
                  }
                  return "fixture result"
                }),
            }),
          ]),
        )
        yield* boundary === "custom" ? applications.register(definitions) : registry.register(definitions)
        const sessions = yield* SessionV2.Service
        const tidy = yield* MemoryTidy.Service
        const store = yield* MemoryTidyStore.Service
        const runner = yield* SessionRunner.Service
        const sessionID = yield* Effect.gen(function* () {
          if (boundary !== "ordinary") {
            state.run = (yield* tidy.prepare({ requestID: "confirmed-tidy", model: selected })).run
            return state.run.session_id
          }
          const session = yield* sessions.create({
            model: selected,
            location: { directory: AbsolutePath.make(tmp.path) },
          })
          yield* sessions.prompt({ sessionID: session.id, resume: false, prompt: { text: "Review the fixture." } })
          return session.id
        })
        if (boundary === "disabled")
          state.before = Effect.sync(() => {
            state.enabled = false
          })
        if (boundary === "cancelled") state.before = store.finish(state.run!.id, "cancelled").pipe(Effect.orDie)
        if (boundary === "model")
          state.before = sessions
            .switchModel({
              sessionID,
              model: { ...selected, id: ModelV2.ID.make("different") },
            })
            .pipe(Effect.asVoid, Effect.orDie)
        yield* runner.run({ sessionID, force: true })
        expect(requests.length).toBeGreaterThan(0)
        if (boundary !== "ordinary") {
          if (boundary === "custom") expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain("read")
          else expect(requests[0]!.tools.map((tool) => tool.name)).toContain("read")
          if (boundary === "queued") expect(requests[0]!.tools.map((tool) => tool.name)).toContain("grep")
          else
            for (const name of names.slice(1)) expect(requests[0]!.tools.map((tool) => tool.name)).not.toContain(name)
        }
        expect(executed.toSorted()).toEqual(
          boundary === "ordinary" ? names.toSorted() : boundary === "active" || boundary === "queued" ? ["read"] : [],
        )
        const transcript = yield* sessions.context(sessionID)
        const calls = transcript.flatMap((message) =>
          message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
        )
        expect(calls).toHaveLength(names.length)
        for (const call of calls) {
          if (executed.includes(call.name)) expect(call.state.status).toBe("completed")
          else
            expect(call.state).toMatchObject({
              status: "error",
              error: { message: expect.stringContaining("memory tidy task") },
            })
        }
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              node,
              MemoryTidy.node,
              MemoryTidyStore.node,
              SessionV2.node,
              ToolRegistry.node,
              ApplicationTools.node,
            ]),
            [
              [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
              [
                Global.node,
                Global.layerWith({
                  data: path.join(tmp.path, "data"),
                  config: path.join(tmp.path, "config"),
                  state: path.join(tmp.path, "state"),
                }),
              ],
              [LayerNodePlatform.llmClient, client],
              // These tests exercise tool dispatch with scripted events, not a
              // provider transport. The real HTTP budget path has its own tests.
              [
                MemoryTidyExecution.node,
                Layer.succeed(MemoryTidyExecution.Service, {
                  prepare: (_id, request) => Effect.succeed(request),
                  wrap: (_id, _request, stream) => stream,
                }),
              ],
              [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(model))],
              [SessionExecution.node, SessionExecution.noopLayer],
              [PluginV2.node, Layer.mock(PluginV2.Service, { wait: () => Effect.void })],
              [Snapshot.node, Snapshot.noopLayer],
              [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
              [
                Config.node,
                Layer.succeed(
                  Config.Service,
                  Config.Service.of({
                    entries: () =>
                      Effect.sync(() => [
                        new Config.Document({
                          type: "document",
                          info: new Config.Info({
                            memory: { enabled: state.enabled },
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
            ],
          ),
        ),
        Effect.scoped,
      ),
    )
  })
