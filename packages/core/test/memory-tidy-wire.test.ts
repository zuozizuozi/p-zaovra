import { expect, test } from "bun:test"
import { DateTime, Effect, Stream } from "effect"
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http"
import { GenerationOptions, HttpOptions, LLMRequest } from "@zaovra-ai/llm"
import { LLMClient, RequestExecutor } from "@zaovra-ai/llm/route"
import { OpenAIChat } from "@zaovra-ai/llm/protocols/openai-chat"
import { OpenAICompatibleChat } from "@zaovra-ai/llm/protocols/openai-compatible-chat"
import { OpenAIResponses } from "@zaovra-ai/llm/protocols/openai-responses"
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
import { SessionEvent } from "../src/session/event"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { Prompt } from "../src/session/prompt"
import { testEffect } from "./lib/effect"

const request = new LLMRequest({ model: OpenAIChat.route.model({ id: "tidy" }), system: [], messages: [], tools: [] })
const wire = (body: Record<string, unknown>, url = "https://api.openai.com/v1/chat/completions") =>
  HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))
const body = { model: "tidy", stream: true, messages: [], max_tokens: 32 }

test("wire bounds reject ambiguous output, hosted work, changed models and unknown extensions", () => {
  expect(MemoryTidyBudget.wireLimit(request, wire(body), 64)).toBe(32)
  for (const patch of [
    { max_tokens: 65 },
    { max_tokens: 0 },
    { max_tokens: 1.5 },
    { max_tokens: "32" },
    { max_tokens: undefined },
    { max_completion_tokens: 32 },
    { max_output_tokens: 32 },
    { n: 2 },
    { web_search_options: {} },
    { functions: [] },
    { background: true },
    { previous_response_id: "prior" },
    { unknown_provider_option: true },
    { model: "other" },
    { stream: false },
    { tools: [{ type: "web_search" }] },
  ])
    expect(MemoryTidyBudget.wireLimit(request, wire({ ...body, ...patch }), 64)).toBeUndefined()
  expect(
    MemoryTidyBudget.wireLimit(request, wire({ ...body, max_tokens: undefined, max_completion_tokens: 32 }), 64),
  ).toBe(32)
  expect(
    MemoryTidyBudget.wireLimit(request, wire(body, "https://other.invalid/v1/chat/completions"), 64),
  ).toBeUndefined()
  expect(
    MemoryTidyBudget.wireLimit(request, wire(body, "https://api.openai.com/v1/chat/completions?n=2"), 64),
  ).toBeUndefined()
  expect(
    MemoryTidyBudget.wireLimit(request, wire(body).pipe(HttpClientRequest.setUrlParam("n", "2")), 64),
  ).toBeUndefined()
  expect(
    MemoryTidyBudget.wireLimit(
      request,
      HttpClientRequest.post("https://api.openai.com/v1/chat/completions").pipe(HttpClientRequest.bodyText("not JSON")),
      64,
    ),
  ).toBeUndefined()
})

test("only the builtin receipt transports qualify; their id alone proves nothing", () => {
  const copied = OpenAIChat.route.with({ transport: { ...OpenAIChat.httpTransport } }).model({ id: "tidy" })
  expect(MemoryTidyBudget.wireLimit(new LLMRequest({ ...request, model: copied }), wire(body), 64)).toBeUndefined()
  const compatible = OpenAICompatibleChat.route
    .with({ endpoint: { baseURL: "https://api.openai.com/v1" } })
    .model({ id: "tidy", provider: "openai" })
  expect(MemoryTidyBudget.wireLimit(new LLMRequest({ ...request, model: compatible }), wire(body), 64)).toBe(32)
  const response = new LLMRequest({ ...request, model: OpenAIResponses.route.model({ id: "tidy" }) })
  const input = { model: "tidy", stream: true, input: [], max_output_tokens: 32 }
  expect(MemoryTidyBudget.wireLimit(response, wire(input, "https://api.openai.com/v1/responses"), 64)).toBe(32)
  expect(
    MemoryTidyBudget.wireLimit(response, wire({ ...input, max_tokens: 32 }, "https://api.openai.com/v1/responses"), 64),
  ).toBeUndefined()
  const websocket = new LLMRequest({ ...request, model: OpenAIResponses.webSocketRoute.model({ id: "tidy" }) })
  expect(MemoryTidyBudget.wireLimit(websocket, wire(input, "https://api.openai.com/v1/responses"), 64)).toBeUndefined()
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([MemoryTidyBudget.node, MemoryTidyStore.node, Database.node, EventV2.node, SessionProjector.node]),
  ),
)
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
      requestID: "wire-test",
      scope: Memory.Scope.make("wire-test"),
      directory: "/",
      model,
      tokens: 500,
      dailyTokens: 1000,
    },
    (sessionID) =>
      Effect.gen(function* () {
        yield* events.publish(SessionEvent.Created, {
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
        const admitted = yield* SessionInput.admit(database.db, events, {
          id: SessionMessage.ID.create(),
          sessionID,
          delivery: "steer",
          prompt: Prompt.make({ text: "tidy" }),
        })
        return { id: admitted.id, seq: admitted.admittedSeq }
      }),
  )
  return { store, budget, run, authority: { sessionID: run.session_id, scope: run.scope, enabled: true } }
})

for (const scenario of ["success", "over-budget", "overlay", "redirect"] as const) {
  it.live(`physical wire admission ${scenario} is enforced before generation`, () =>
    Effect.gen(function* () {
      const h = yield* host
      const state = { requests: 0, chargedAtSend: 0 }
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch() {
              state.requests++
              state.chargedAtSend = (await Effect.runPromise(h.store.usage({ runID: h.run.id }))).charged
              if (scenario === "redirect")
                return new Response(null, { status: 307, headers: { location: "/unadmitted" } })
              return new Response(
                `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } },
              )
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const outgoing = new LLMRequest({
        model: OpenAIChat.route.with({ endpoint: { baseURL: server.url.href } }).model({ id: "tidy" }),
        system: [],
        messages: [],
        tools: [],
        generation: GenerationOptions.make({ maxTokens: 32 }),
        ...(scenario === "overlay" ? { http: HttpOptions.make({ body: { n: 2 } }) } : {}),
      })
      const result = yield* LLMClient.stream(outgoing).pipe(
        Stream.runDrain,
        Effect.provideService(RequestExecutor.RequestAdmission, (attempt) =>
          h.budget.admit({
            authority: h.authority,
            id: attempt.id,
            request: outgoing,
            wire: attempt.request,
            inputLimit: scenario === "over-budget" ? 500 : 100,
            outputLimit: 32,
          }),
        ),
        Effect.provideService(RequestExecutor.RequestCompletion, (receipt) =>
          h.budget.complete(h.run.id, receipt).pipe(Effect.asVoid),
        ),
        Effect.provideService(RequestExecutor.AutomaticRetries, false),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.provide(LLMClient.layer),
        Effect.provide(RequestExecutor.fetchLayer),
        Effect.exit,
      )
      expect(result._tag).toBe(scenario === "success" ? "Success" : "Failure")
      expect(state.requests).toBe(scenario === "success" || scenario === "redirect" ? 1 : 0)
      expect(state.chargedAtSend).toBe(state.requests ? 132 : 0)
      expect(yield* h.store.usage({ runID: h.run.id })).toEqual(
        scenario === "success"
          ? { known: 15, reserved: 0, charged: 15, unknown: 0 }
          : scenario === "redirect"
            ? { known: 0, reserved: 132, charged: 132, unknown: 1 }
            : { known: 0, reserved: 0, charged: 0, unknown: 0 },
      )
    }),
  )
}
