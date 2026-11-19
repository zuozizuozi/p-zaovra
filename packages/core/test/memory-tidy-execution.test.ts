import { expect, test } from "bun:test"
import path from "node:path"
import { Cause, DateTime, Effect, Exit, Layer, Stream } from "effect"
import { GenerationOptions, HttpOptions, LLMRequest, Message, SystemPart, ToolDefinition } from "@zaovra-ai/llm"
import { LLMClient, RequestExecutor } from "@zaovra-ai/llm/route"
import { OpenAIResponses } from "@zaovra-ai/llm/protocols/openai-responses"
import { OpenAIChat } from "@zaovra-ai/llm/protocols/openai-chat"
import { Config } from "../src/config"
import { ConfigCompaction } from "../src/config/compaction"
import { ConfigExperimental } from "../src/config/experimental"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { MemoryTidy } from "../src/memory/tidy"
import { MemoryAutomaticStore } from "../src/memory/automatic-store"
import { MemoryStore } from "../src/memory/store"
import { MemoryTidyExecution } from "../src/memory/tidy-execution"
import { MemoryTidyStore } from "../src/memory/tidy-store"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { PluginV2 } from "../src/plugin"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionCompaction } from "../src/session/compaction"
import { SessionExecution } from "../src/session/execution"
import { SessionExecutionStatus } from "../src/session/execution-status"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { SessionRunner } from "../src/session/runner/index"
import { node } from "../src/session/runner/llm"
import { SessionRunnerModel } from "../src/session/runner/model"
import { Snapshot } from "../src/snapshot"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

const selected = { id: ModelV2.ID.make("catalog-alias"), providerID: ProviderV2.ID.make("fixture") }
const summary = `## Objective
Keep the requested task.
## Important Details
Preserve the archived evidence.
## Work State
### Completed
Read the history.
### Active
Review the memory.
### Blocked
None.
## Next Move
Finish the review.
## Relevant Files
No files changed.`

for (const scenario of [
  "success",
  "over-budget",
  "count-missing",
  "count-invalid",
  "count-redirect",
  "generation-redirect",
  "cancel-during-count",
  "automatic-busy-during-count",
  "automatic-revoked-during-count",
  "config-during-count",
  "route-during-count",
  "defaults-during-count",
  "unknown-usage",
  "retry",
  "retry-revoked",
  "unsupported",
  "ordinary",
  "remote-image",
  "overlay",
  "runner",
  "runner-unbounded",
  "summary",
  "summary-revoked",
] as const)
  test(`tidy execution uses the real HTTP admission and durable budget: ${scenario}`, async () => {
    await using tmp = await tmpdir()
    const state = {
      enabled: true,
      counted: [] as Record<string, unknown>[],
      generated: [] as Record<string, unknown>[],
      charges: [] as number[],
      redirects: 0,
      admissions: 0,
      completions: 0,
      duringCount: async () => {},
      charged: async () => 0,
    }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(incoming) {
        const url = new URL(incoming.url)
        if (url.pathname === "/unadmitted") {
          state.redirects++
          return Response.json({ object: "response.input_tokens", input_tokens: 100 })
        }
        const body = (await incoming.json()) as Record<string, unknown>
        if (url.pathname === "/responses/input_tokens") {
          state.counted.push(body)
          await state.duringCount()
          if (scenario === "count-missing") return Response.json({ error: "unsupported" }, { status: 404 })
          if (scenario === "count-redirect")
            return new Response(null, { status: 307, headers: { location: "/unadmitted" } })
          return Response.json({
            object: "response.input_tokens",
            input_tokens: scenario === "over-budget" ? 500 : scenario === "count-invalid" ? -1 : 100,
          })
        }
        state.generated.push(body)
        state.charges.push(await state.charged())
        if ((scenario === "retry" || scenario === "retry-revoked") && state.generated.length === 1)
          return Response.json({ error: { type: "server_error", message: "Fixture retry." } }, { status: 503 })
        if (scenario === "generation-redirect")
          return new Response(null, { status: 307, headers: { location: "/unadmitted" } })
        if (scenario === "ordinary")
          return new Response(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
          )
        return new Response(
          [
            {
              type: "response.output_text.delta",
              item_id: "answer",
              delta: scenario === "summary" ? summary : "The review is complete.",
            },
            {
              type: "response.completed",
              response: {
                id: "answer",
                status: "completed",
                output: [],
                ...(scenario === "unknown-usage"
                  ? {}
                  : { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }),
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const current = {
      model: (scenario === "unsupported" || scenario === "ordinary" ? OpenAIChat.route : OpenAIResponses.route)
        .with({
          endpoint: { baseURL: server.url.href },
          limits: { context: 8192, output: 32 },
          generation: scenario === "runner-unbounded" ? undefined : { maxTokens: 32 },
        })
        .model({ id: "api-model", provider: selected.providerID }),
    }
    const entries = () => [
      new Config.Document({
        type: "document",
        info: new Config.Info({
          memory: { enabled: state.enabled },
          compaction: new ConfigCompaction.Info({ auto: false, keep: new ConfigCompaction.Keep({ tokens: 0 }) }),
          experimental: new ConfigExperimental.Experimental({
            verification: false,
            delivery_contract: false,
            quality_progress: { facts: false, stagnation_log: false },
          }),
        }),
      }),
    ]
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const tidy = yield* MemoryTidy.Service
          const store = yield* MemoryTidyStore.Service
          const guard = yield* MemoryTidyExecution.Service
          const sessions = yield* SessionV2.Service
          const llm = yield* LLMClient.Service
          const automatic = yield* MemoryAutomaticStore.Service
          const active = new Set<SessionV2.ID>()
          const status = yield* SessionExecutionStatus.Service
          yield* status.track(Effect.sync(() => active))
          const prepareAutomatic = Effect.gen(function* () {
            const memory = yield* MemoryStore.Service
            const here = yield* Location.Service
            const events = yield* EventV2.Service
            const source = yield* sessions.create({ model: selected, location: { directory: here.directory } })
            const timestamp = yield* DateTime.now
            const assistantMessageID = SessionMessage.ID.create()
            yield* events.publish(SessionEvent.Prompted, {
              sessionID: source.id,
              timestamp,
              messageID: SessionMessage.ID.create(),
              prompt: { text: "Completed ordinary work" },
              delivery: "steer",
            })
            yield* events.publish(SessionEvent.Step.Started, {
              sessionID: source.id,
              timestamp,
              assistantMessageID,
              model: selected,
              agent: "build",
            })
            yield* events.publish(SessionEvent.Step.Ended, {
              sessionID: source.id,
              timestamp,
              assistantMessageID,
              finish: "stop",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            })
            const place = {
              directory: here.directory,
              project: here.project.id,
              scope: yield* memory.scope({ directory: here.directory, project: here.project.id }),
            }
            yield* automatic.confirm(place, { requestID: "automatic", model: selected, tokens: 500, dailyTokens: 1000 })
            const run = yield* automatic.claim(place, "automatic", Effect.succeed(true), (request) =>
              tidy.prepare(request).pipe(Effect.map((view) => view.run)),
            )
            expect(run).toBeDefined()
            return run!
          })
          const run =
            scenario === "ordinary"
              ? undefined
              : scenario.startsWith("automatic-")
                ? yield* prepareAutomatic
                : (yield* tidy.prepare({ requestID: "confirmed", model: selected, tokens: 500 })).run
          const sessionID =
            run?.session_id ??
            (yield* sessions.create({ model: selected, location: { directory: AbsolutePath.make(tmp.path) } })).id
          if (run)
            state.charged = () => Effect.runPromise(store.usage({ runID: run.id })).then((usage) => usage.charged)
          state.duringCount = async () => {
            if (scenario === "automatic-busy-during-count") active.add(SessionV2.ID.create())
            if (scenario === "automatic-revoked-during-count")
              await Effect.runPromise(automatic.disable(tmp.path, "automatic"))
            if (scenario === "cancel-during-count") await Effect.runPromise(store.finish(run!.id, "cancelled"))
            if (scenario === "config-during-count") state.enabled = false
            if (scenario === "retry-revoked" && state.counted.length === 2) state.enabled = false
            if (scenario === "route-during-count")
              current.model = current.model.route
                .with({ endpoint: { baseURL: "https://changed.invalid" } })
                .model({ id: "api-model", provider: selected.providerID })
            if (scenario === "defaults-during-count")
              current.model = current.model.route
                .with({ generation: { maxTokens: 8 } })
                .model({ id: "api-model", provider: selected.providerID })
          }
          const request = new LLMRequest({
            model: current.model,
            system: [SystemPart.make("Preserve the user's own words.")],
            messages: [Message.user("Review recorded facts.")],
            tools: [
              ToolDefinition.make({
                name: "memory_search",
                description: "Search facts",
                inputSchema: { type: "object", properties: { query: { type: "string" } } },
              }),
            ],
            generation: GenerationOptions.make({ maxTokens: 32 }),
            ...(scenario === "overlay"
              ? { http: HttpOptions.make({ body: { tools: [{ type: "web_search" }] } }) }
              : {}),
            ...(scenario === "remote-image"
              ? {
                  http: HttpOptions.make({
                    body: {
                      input: [
                        {
                          type: "message",
                          role: "user",
                          content: [{ type: "input_image", image_url: "https://mutable.invalid/image.png" }],
                        },
                      ],
                    },
                  }),
                }
              : {}),
          })
          const outcome = yield* Effect.gen(function* () {
            if (scenario === "runner" || scenario === "runner-unbounded") {
              const runner = yield* SessionRunner.Service
              yield* runner.run({ sessionID, force: true })
              return
            }
            if (scenario === "summary" || scenario === "summary-revoked") {
              const database = yield* Database.Service
              const events = yield* EventV2.Service
              if (scenario === "summary-revoked") yield* store.finish(run!.id, "cancelled")
              const compact = SessionCompaction.make({
                db: database.db,
                events,
                llm,
                config: entries(),
                wrap: guard.wrap,
                prepare: guard.prepare,
              })
              const compacted = yield* compact.compactAfterOverflow({
                sessionID,
                model: request.model,
                request,
                reason: "manual",
                entries: [
                  {
                    seq: 1,
                    message: {
                      id: SessionMessage.ID.create(),
                      type: "user",
                      text: "Archived task to preserve.",
                      time: { created: DateTime.makeUnsafe(0) },
                    },
                  },
                ],
              })
              expect(compacted).toBe(scenario === "summary")
              if (scenario === "summary-revoked") {
                const stored = yield* database.db.select().from(EventTable).all().pipe(Effect.orDie)
                expect(
                  stored.filter((event) => event.type === EventV2.versionedType("session.next.compaction.started", 1)),
                ).toHaveLength(1)
                expect(
                  stored.filter((event) => event.type === EventV2.versionedType("session.next.compaction.failed", 1)),
                ).toHaveLength(1)
                expect(
                  stored.filter((event) => event.type === EventV2.versionedType("session.next.compaction.ended", 1)),
                ).toHaveLength(0)
              }
              return
            }
            yield* guard.wrap(sessionID, request, llm.stream(request)).pipe(Stream.runDrain)
          }).pipe(
            Effect.provideService(
              RequestExecutor.AutomaticRetries,
              scenario === "retry" || scenario === "retry-revoked",
            ),
            Effect.provideService(RequestExecutor.RequestAdmission, () =>
              Effect.sync(() => {
                state.admissions++
              }),
            ),
            Effect.provideService(RequestExecutor.RequestCompletion, () =>
              Effect.sync(() => {
                state.completions++
              }),
            ),
            Effect.exit,
          )
          const sent = [
            "success",
            "unknown-usage",
            "ordinary",
            "runner",
            "runner-unbounded",
            "summary",
            "generation-redirect",
            "retry",
            "retry-revoked",
          ].includes(scenario)
          if (scenario === "runner" && Exit.isFailure(outcome)) throw new Error(Cause.pretty(outcome.cause))
          expect(outcome._tag).toBe(
            scenario === "summary-revoked" ||
              (sent && scenario !== "generation-redirect" && scenario !== "retry-revoked")
              ? "Success"
              : "Failure",
          )
          if (Exit.isFailure(outcome) && scenario === "count-missing")
            expect(Cause.pretty(outcome.cause)).toContain("HTTP 404")
          if (Exit.isFailure(outcome) && scenario === "count-invalid")
            expect(Cause.pretty(outcome.cause)).toContain("输入计数无效")
          expect(state.redirects).toBe(0)
          expect(state.generated).toHaveLength(scenario === "retry" ? 2 : sent ? 1 : 0)
          expect(state.counted).toHaveLength(
            ["ordinary", "unsupported", "remote-image", "overlay", "summary-revoked"].includes(scenario)
              ? 0
              : scenario === "retry" || scenario === "retry-revoked"
                ? 2
                : 1,
          )
          if (sent)
            expect(state.charges).toEqual(scenario === "retry" ? [132, 264] : [scenario === "ordinary" ? 0 : 132])
          if (scenario === "runner-unbounded") {
            expect(state.generated[0]?.max_output_tokens).toBe(32)
            expect(state.counted[0]?.input).toEqual(state.generated[0]?.input)
          }
          if (scenario === "success") {
            const generated = state.generated[0]!
            const counted = state.counted[0]!
            expect(counted.model).toBe("api-model")
            expect(counted.input).toEqual(generated.input)
            expect(counted.instructions).toEqual(generated.instructions)
            expect(counted.tools).toEqual(generated.tools)
            expect(counted).not.toHaveProperty("stream")
            expect(counted).not.toHaveProperty("max_output_tokens")
            expect(state.admissions).toBe(1)
            expect(state.completions).toBe(1)
          }
          if (run)
            expect(yield* store.usage({ runID: run.id })).toEqual(
              scenario === "retry"
                ? { known: 15, reserved: 132, charged: 147, unknown: 1 }
                : scenario === "unknown-usage" || scenario === "generation-redirect" || scenario === "retry-revoked"
                  ? { known: 0, reserved: 132, charged: 132, unknown: 1 }
                  : sent
                    ? { known: 15, reserved: 0, charged: 15, unknown: 0 }
                    : { known: 0, reserved: 0, charged: 0, unknown: 0 },
            )
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(
              LayerNode.group([
                node,
                MemoryTidy.node,
                MemoryTidyExecution.node,
                MemoryTidyStore.node,
                MemoryAutomaticStore.node,
                MemoryStore.node,
                SessionExecutionStatus.node,
                Location.node,
                SessionV2.node,
                LayerNodePlatform.llmClient,
                Database.node,
                EventV2.node,
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
                [SessionExecution.node, SessionExecution.noopLayer],
                [SessionRunnerModel.node, SessionRunnerModel.layerWith(() => Effect.succeed(current.model))],
                [
                  Config.node,
                  Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.sync(entries) })),
                ],
                [PluginV2.node, Layer.mock(PluginV2.Service, { wait: () => Effect.void })],
                [Snapshot.node, Snapshot.noopLayer],
              ],
            ),
          ),
          Effect.scoped,
        ),
      )
    } finally {
      server.stop(true)
    }
  })
