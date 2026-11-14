import { expect, test } from "bun:test"
import { DateTime, Effect, Stream } from "effect"
import { LLMRequest, Usage } from "@zaovra-ai/llm"
import { LLMClient, RequestExecutor } from "@zaovra-ai/llm/route"
import { OpenAIChat } from "@zaovra-ai/llm/protocols/openai-chat"
import { Memory } from "@zaovra-ai/schema/memory"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { MemoryTidyBudget } from "../src/memory/tidy-budget"
import { MemoryTidyStore } from "../src/memory/tidy-store"
import { ModelV2 } from "../src/model"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath, RelativePath } from "../src/schema"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { SessionEvent } from "../src/session/event"
import { SessionProjector } from "../src/session/projector"
import { testEffect } from "./lib/effect"

const chat = (raw: Record<string, unknown>, extra: Partial<ConstructorParameters<typeof Usage>[0]> = {}) =>
  new Usage({ inputTokens: 100, outputTokens: 20, providerMetadata: { openai: raw }, ...extra })

test("native input/output totals include cache and reasoning exactly once", () => {
  expect(
    MemoryTidyBudget.reported(
      "openai-chat",
      chat(
        {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 80 },
          completion_tokens_details: { reasoning_tokens: 15 },
        },
        { totalTokens: 120, nonCachedInputTokens: 20, cacheReadInputTokens: 80, reasoningTokens: 15 },
      ),
    ),
  ).toBe(120)
  expect(
    MemoryTidyBudget.reported(
      "openai-responses",
      chat(
        { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 15 } },
        { reasoningTokens: 15 },
      ),
    ),
  ).toBe(120)
  expect(
    MemoryTidyBudget.reported(
      "openai-chat",
      chat(
        { prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens: 20 },
        { cacheReadInputTokens: 80, nonCachedInputTokens: 20 },
      ),
    ),
  ).toBe(120)
})

for (const [name, raw] of [
  ["missing input", { completion_tokens: 20, total_tokens: 120 }],
  ["missing output", { prompt_tokens: 100, total_tokens: 120 }],
  ["missing one cache axis", { prompt_cache_hit_tokens: 100, completion_tokens: 20 }],
  ["contradictory total", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 121 }],
  [
    "contradictory cache",
    { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 30 },
  ],
  [
    "oversized cache subset",
    { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 101 } },
  ],
  [
    "invalid reasoning subset",
    { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: -1 } },
  ],
  ["invalid detail shape", { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: [] }],
  ["fraction", { prompt_tokens: 100.1, completion_tokens: 20 }],
  ["numeric string", { prompt_tokens: "100", completion_tokens: 20 }],
  ["unsafe sum", { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 20 }],
] as const)
  test(`incomplete or inconsistent native usage remains unknown: ${name}`, () => {
    expect(MemoryTidyBudget.reported("openai-chat", chat(raw))).toBeUndefined()
  })

test("normalized or synthetic totals cannot replace native billing evidence", () => {
  expect(MemoryTidyBudget.reported("openai-chat", undefined)).toBeUndefined()
  expect(
    MemoryTidyBudget.reported("openai-chat", new Usage({ inputTokens: 100, outputTokens: 20, totalTokens: 120 })),
  ).toBeUndefined()
  expect(MemoryTidyBudget.reported("other", chat({ prompt_tokens: 100, completion_tokens: 20 }))).toBeUndefined()
  expect(
    MemoryTidyBudget.reported("openai-chat", chat({ prompt_tokens: 100, completion_tokens: 20 }, { outputTokens: 19 })),
  ).toBeUndefined()
  expect(
    MemoryTidyBudget.reported(
      "openai-chat",
      chat({ prompt_tokens: 100, completion_tokens: 20 }, { cacheWriteInputTokens: 1 }),
    ),
  ).toBeUndefined()
  expect(
    MemoryTidyBudget.reported(
      "openai-chat",
      chat({ prompt_tokens: 0, completion_tokens: 0 }, { inputTokens: 0, outputTokens: 0 }),
    ),
  ).toBe(0)
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([MemoryTidyBudget.node, MemoryTidyStore.node, Database.node, EventV2.node, SessionProjector.node]),
  ),
)
const request = new LLMRequest({ model: OpenAIChat.route.model({ id: "tidy" }), system: [], messages: [], tools: [] })
const host = Effect.gen(function* () {
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const store = yield* MemoryTidyStore.Service
  const budget = yield* MemoryTidyBudget.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const model = { id: ModelV2.ID.make("tidy"), providerID: ProviderV2.ID.make("openai") }
  const run = yield* store.create(
    {
      requestID: "confirmed",
      scope: Memory.Scope.make("project"),
      directory: "/",
      model,
      tokens: 500,
      dailyTokens: 1000,
    },
    (sessionID) =>
      events
        .publish(SessionEvent.Created, {
          sessionID,
          timestamp: DateTime.makeUnsafe(0),
          projectID: Project.ID.global,
          location: { directory: AbsolutePath.make("/") },
          subpath: RelativePath.make(""),
          title: "Tidy",
          slug: "tidy",
          version: "test",
          model,
        })
        .pipe(
          Effect.andThen(
            SessionInput.admit(database.db, events, {
              id: SessionMessage.ID.create(),
              sessionID,
              prompt: { text: "Tidy" },
              delivery: "steer",
            }),
          ),
          Effect.map((input) => ({ id: input.id, seq: input.admittedSeq })),
        ),
  )
  return { store, budget, run, authority: { sessionID: run.session_id, scope: run.scope, enabled: true } }
})

it.effect("a late completed receipt settles only its attempt, retaining earlier unknown reservations", () =>
  Effect.gen(function* () {
    const h = yield* host
    yield* h.store.reserve({ ...h.authority, attemptID: "failed", tokens: 150 })
    yield* h.store.reserve({ ...h.authority, attemptID: "finished", tokens: 150 })
    yield* h.store.finish(h.run.id, "cancelled")
    const receipt = { id: "finished", request, usage: chat({ prompt_tokens: 100, completion_tokens: 20 }) }
    expect(yield* h.budget.complete(h.run.id, receipt)).toBe("settled")
    expect(yield* h.budget.complete(h.run.id, receipt)).toBe("settled")
    expect(yield* h.store.usage({ runID: h.run.id })).toEqual({ known: 120, reserved: 150, charged: 270, unknown: 1 })
    expect((yield* h.store.get(h.run.id))?.state).toBe("cancelled")
    expect((yield* h.budget.complete("other-run", receipt).pipe(Effect.flip)).retryable).toBe(false)
  }),
)

it.effect("missing usage never releases a reservation; conflicting receipts do not overwrite a settlement", () =>
  Effect.gen(function* () {
    const h = yield* host
    yield* h.store.reserve({ ...h.authority, attemptID: "one", tokens: 150 })
    expect(yield* h.budget.complete(h.run.id, { id: "one", request })).toBe("unknown")
    expect((yield* h.store.usage({ runID: h.run.id })).reserved).toBe(150)
    yield* h.budget.complete(h.run.id, {
      id: "one",
      request,
      usage: chat({ prompt_tokens: 100, completion_tokens: 20 }),
    })
    const conflict = yield* h.budget
      .complete(h.run.id, {
        id: "one",
        request,
        usage: chat({ prompt_tokens: 100, completion_tokens: 21 }, { outputTokens: 21 }),
      })
      .pipe(Effect.flip)
    expect(conflict.retryable).toBe(false)
    expect((yield* h.store.usage({ runID: h.run.id })).known).toBe(120)
  }),
)

it.effect("a provider overrun is persisted before a non-retryable stop, never clamped to its reservation", () =>
  Effect.gen(function* () {
    const h = yield* host
    yield* h.store.reserve({ ...h.authority, attemptID: "overrun", tokens: 100 })
    const error = yield* h.budget
      .complete(h.run.id, { id: "overrun", request, usage: chat({ prompt_tokens: 100, completion_tokens: 20 }) })
      .pipe(Effect.flip)
    expect(error.reason._tag).toBe("QuotaExceeded")
    expect(error.retryable).toBe(false)
    expect((yield* h.store.usage({ runID: h.run.id })).known).toBe(120)
    expect((yield* h.store.get(h.run.id))?.state).toBe("failed")
  }),
)

it.live("real HTTP retry receipts settle their own parsed usage into the durable ledger", () =>
  Effect.gen(function* () {
    const h = yield* host
    const received: string[] = []
    const admitted: string[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(incoming) {
            received.push(await incoming.text())
            if (received.length === 1) return new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } })
            return new Response(
              [
                { choices: [{ delta: { content: "done" } }] },
                {
                  choices: [{ delta: {}, finish_reason: "stop" }],
                  usage: {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    total_tokens: 120,
                    prompt_tokens_details: { cached_tokens: 80 },
                    completion_tokens_details: { reasoning_tokens: 15 },
                  },
                },
              ]
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join("") + "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            )
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    yield* LLMClient.stream(
      new LLMRequest({
        model: OpenAIChat.route.with({ endpoint: { baseURL: server.url.href } }).model({ id: "tidy" }),
        system: [],
        messages: [],
        tools: [],
      }),
    ).pipe(
      Stream.runDrain,
      Effect.provideService(RequestExecutor.RequestAdmission, ({ id }) =>
        h.store.reserve({ ...h.authority, attemptID: id, tokens: 150 }).pipe(
          Effect.orDie,
          Effect.tap(() =>
            Effect.sync(() => {
              admitted.push(id)
            }),
          ),
        ),
      ),
      Effect.provideService(RequestExecutor.RequestCompletion, (receipt) =>
        h.budget.complete(h.run.id, receipt).pipe(Effect.asVoid),
      ),
      Effect.provide(LLMClient.layer),
      Effect.provide(RequestExecutor.fetchLayer),
    )
    expect(received).toHaveLength(2)
    expect(new Set(admitted).size).toBe(2)
    expect(yield* h.store.usage({ runID: h.run.id })).toEqual({ known: 120, reserved: 150, charged: 270, unknown: 1 })
  }),
)
