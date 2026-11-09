import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { LLM, LLMError, LLMEvent, InvalidRequestReason, Message, ToolCallPart } from "../src"
import { Auth, LLMClient, RequestExecutor } from "../src/route"
import { OpenAIResponses } from "../src/protocols/openai-responses"
import { OpenAIChat } from "../src/protocols/openai-chat"
import { recoverEncryptedContent } from "../src/route/encrypted-recovery"
import { testEffect } from "./lib/effect"
import { dynamicResponse } from "./lib/http"
import { sseEvents } from "./lib/sse"

const rejected = {
  error: { code: "invalid_encrypted_content", type: "invalid_request_error", message: "cipher rejected" },
}
const completed = {
  type: "response.completed",
  response: {
    id: "resp_ok",
    model: "local-test-model",
    status: "completed",
    output: [],
    usage: { input_tokens: 10, output_tokens: 2 },
  },
}
const request = LLM.request({
  model: OpenAIResponses.route.with({ auth: Auth.bearer("local-test") }).model({ id: "local-test-model" }),
  messages: [
    Message.user("keep user text"),
    Message.assistant([
      {
        type: "reasoning",
        text: "summary",
        providerMetadata: { openai: { itemId: "rs_old", reasoningEncryptedContent: "local-cipher" } },
      },
      { type: "text", text: "keep assistant text" },
      ToolCallPart.make({ id: "call_1", name: "lookup", input: { encrypted_content: "ordinary tool data" } }),
    ]),
    Message.tool({ id: "call_1", name: "lookup", result: "already completed" }),
    Message.user("continue"),
  ],
  providerOptions: {
    openai: {
      store: false,
      include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
      reasoningEffort: "high",
    },
  },
  generation: { maxTokens: 128000 },
})

const bodies: Record<string, unknown>[] = []
const fixture = dynamicResponse(({ text, respond }) =>
  Effect.sync(() => {
    bodies.push(JSON.parse(text))
    if (bodies.length === 1) return respond(JSON.stringify(rejected), { status: 400 })
    return respond(sseEvents(completed), { headers: { "content-type": "text/event-stream" } })
  }),
)

const offline = testEffect(Layer.empty)
offline.effect("771 second SSE rejection is returned without a third request", () =>
  Effect.gen(function* () {
    let attempts = 0
    const events = yield* LLMClient.stream(request).pipe(
      Stream.runCollect,
      Effect.provide(
        dynamicResponse(({ respond }) =>
          Effect.sync(() => {
            attempts++
            return respond(sseEvents({ type: "error", code: "invalid_encrypted_content", message: "still rejected" }), {
              headers: { "content-type": "text/event-stream" },
            })
          }),
        ),
      ),
    )
    expect(attempts).toBe(2)
    expect(events.filter((event) => event.type === "provider-error")).toHaveLength(1)
  }),
)

offline.effect("771 successful recovery publishes a new tool call exactly once", () =>
  Effect.gen(function* () {
    let attempts = 0
    const events = yield* LLMClient.stream(request).pipe(
      Stream.runCollect,
      Effect.provide(
        dynamicResponse(({ respond }) =>
          Effect.sync(() => {
            attempts++
            return attempts === 1
              ? respond(JSON.stringify(rejected), { status: 400 })
              : respond(
                  sseEvents(
                    {
                      type: "response.output_item.added",
                      item: { type: "function_call", id: "fc_new", call_id: "call_new", name: "lookup", arguments: "" },
                    },
                    { type: "response.function_call_arguments.delta", item_id: "fc_new", delta: '{"query":"new"}' },
                    {
                      type: "response.output_item.done",
                      item: {
                        type: "function_call",
                        id: "fc_new",
                        call_id: "call_new",
                        name: "lookup",
                        arguments: '{"query":"new"}',
                      },
                    },
                    completed,
                  ),
                  { headers: { "content-type": "text/event-stream" } },
                )
          }),
        ),
      ),
    )
    expect(attempts).toBe(2)
    expect(events.filter((event) => event.type === "tool-call")).toHaveLength(1)
    expect(events.find((event) => event.type === "tool-call")).toMatchObject({
      id: "call_new",
      input: { query: "new" },
    })
  }),
)

offline.effect("771 usage commits an attempt and forbids recovery", () =>
  Effect.gen(function* () {
    let retries = 0
    const observed: LLMEvent[] = []
    const error = new LLMError({
      module: "test",
      method: "stream",
      reason: new InvalidRequestReason({
        message: "rejected",
        providerMetadata: { compatibility: { code: "invalid_encrypted_content" } },
      }),
    })
    const result = yield* Stream.concat(
      Stream.make(LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 20, outputTokens: 4 } })),
      Stream.fail(error),
    ).pipe(
      recoverEncryptedContent(request, () => {
        retries++
        return Stream.empty
      }),
      Stream.tap((event) =>
        Effect.sync(() => {
          observed.push(event)
        }),
      ),
      Stream.runCollect,
      Effect.result,
    )
    expect(retries).toBe(0)
    expect(result._tag).toBe("Failure")
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ usage: { inputTokens: 20, outputTokens: 4 } })
  }),
)
for (const mode of ["error", "response.failed"] as const) {
  offline.effect(`771 recovers from pre-output SSE ${mode} without duplicate starts`, () =>
    Effect.gen(function* () {
      let attempts = 0
      const events = yield* LLMClient.stream(request).pipe(
        Stream.runCollect,
        Effect.provide(
          dynamicResponse(({ respond }) =>
            Effect.sync(() => {
              attempts++
              return respond(
                sseEvents(
                  ...(attempts === 1
                    ? [
                        { type: "response.created", response: { id: "failed" } },
                        mode === "error"
                          ? { type: "error", code: "invalid_encrypted_content", message: "rejected" }
                          : { type: "response.failed", response: { id: "failed", error: rejected.error } },
                      ]
                    : [completed]),
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )
      expect(attempts).toBe(2)
      expect(events.filter((event) => event.type === "step-start")).toHaveLength(1)
      expect(events.filter((event) => event.type === "provider-error")).toHaveLength(0)
    }),
  )
}

for (const failure of [
  { status: 400, body: rejected },
  { status: 503, body: { error: { type: "server_error", message: "unavailable" } } },
]) {
  offline.effect(`771 fallback HTTP ${failure.status} cannot start a third request`, () =>
    Effect.gen(function* () {
      let attempts = 0
      const result = yield* LLMClient.stream(request).pipe(
        Stream.runCollect,
        Effect.result,
        Effect.provide(
          dynamicResponse(({ respond }) =>
            Effect.sync(() => {
              attempts++
              return respond(JSON.stringify(attempts === 1 ? rejected : failure.body), {
                status: attempts === 1 ? 400 : failure.status,
              })
            }),
          ),
        ),
      )
      expect(result._tag).toBe("Failure")
      expect(attempts).toBe(2)
    }),
  )
}

for (const failure of [
  {
    status: 400,
    body: { error: { code: "invalid_argument", message: "invalid_encrypted_content in unrelated text" } },
  },
  { status: 400, body: { error: { code: "invalid_encrypted_content_extra", message: "not this error" } } },
  { status: 401, body: rejected },
  { status: 403, body: rejected },
]) {
  offline.effect(`771 does not change unrelated or auth failure ${failure.status}/${failure.body.error.code}`, () =>
    Effect.gen(function* () {
      let attempts = 0
      yield* LLMClient.stream(request).pipe(
        Stream.runCollect,
        Effect.result,
        Effect.provide(
          dynamicResponse(({ respond }) =>
            Effect.sync(() => {
              attempts++
              return respond(JSON.stringify(failure.body), { status: failure.status })
            }),
          ),
        ),
      )
      expect(attempts).toBe(1)
    }),
  )
}

offline.effect("771 does not retry an unchanged request without encryption", () =>
  Effect.gen(function* () {
    let attempts = 0
    yield* LLMClient.stream(LLM.request({ model: request.model, prompt: "no cipher" })).pipe(
      Stream.runCollect,
      Effect.result,
      Effect.provide(
        dynamicResponse(({ respond }) =>
          Effect.sync(() => {
            attempts++
            return respond(JSON.stringify(rejected), { status: 400 })
          }),
        ),
      ),
    )
    expect(attempts).toBe(1)
  }),
)

for (const frame of [
  { type: "response.output_text.delta", item_id: "text_1", delta: "already visible" },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_new", delta: "visible reasoning" },
  {
    type: "response.output_item.added",
    item: { type: "function_call", id: "fc_1", call_id: "call_new", name: "lookup", arguments: "" },
  },
  {
    type: "response.output_item.added",
    item: { type: "reasoning", id: "rs_new", summary: [], encrypted_content: "new opaque state" },
  },
]) {
  offline.effect(`771 never replays after committed ${frame.type}/${frame.item?.type ?? "delta"}`, () =>
    Effect.gen(function* () {
      let attempts = 0
      const events = yield* LLMClient.stream(request).pipe(
        Stream.runCollect,
        Effect.provide(
          dynamicResponse(({ respond }) =>
            Effect.sync(() => {
              attempts++
              return respond(
                sseEvents(frame, { type: "error", code: "invalid_encrypted_content", message: "too late" }),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )
      expect(attempts).toBe(1)
      expect(events.filter((event) => event.type === "provider-error")).toHaveLength(1)
    }),
  )
}

offline.effect("771 chat recovery removes only opaque state, retaining plaintext reasoning and tool data", () =>
  Effect.gen(function* () {
    const sent: Record<string, unknown>[] = []
    const chat = LLM.request({
      model: OpenAIChat.route.with({ auth: Auth.bearer("local") }).model({ id: "local" }),
      messages: [
        Message.user("continue"),
        new Message({
          role: "assistant",
          native: { openaiCompatible: { encrypted_content: "native-cipher", reasoning_content: "native reasoning" } },
          content: [
            {
              type: "reasoning",
              text: "plaintext reasoning",
              providerMetadata: { openaiCompatible: { encrypted_content: "part-cipher", preserved: true } },
            },
            { type: "text", text: "visible" },
            ToolCallPart.make({ id: "call_1", name: "lookup", input: { encrypted_content: "keep tool argument" } }),
          ],
        }),
        Message.tool({ id: "call_1", name: "lookup", result: { encrypted_content: "keep result" } }),
      ],
      generation: { maxTokens: 128000 },
      providerOptions: { openai: { reasoningEffort: "high" } },
    })
    yield* LLMClient.stream(chat).pipe(
      Stream.runCollect,
      Effect.provide(
        dynamicResponse(({ text, respond }) =>
          Effect.sync(() => {
            sent.push(JSON.parse(text))
            return sent.length === 1
              ? respond(JSON.stringify(rejected), { status: 400 })
              : respond(
                  sseEvents(
                    { choices: [{ delta: { content: "ok" } }] },
                    {
                      choices: [{ delta: {}, finish_reason: "stop" }],
                      usage: { prompt_tokens: 10, completion_tokens: 2 },
                    },
                  ),
                  { headers: { "content-type": "text/event-stream" } },
                )
          }),
        ),
      ),
    )
    expect(sent).toHaveLength(2)
    const initial = sent[0]?.messages as Record<string, unknown>[]
    const recovered = sent[1]?.messages as Record<string, unknown>[]
    expect(initial[1]?.encrypted_content).toBe("part-cipher")
    expect(recovered[1]).not.toHaveProperty("encrypted_content")
    expect(recovered[1]?.reasoning_content).toBe("plaintext reasoning")
    expect(recovered[1]?.tool_calls).toEqual(initial[1]?.tool_calls)
    expect(recovered[2]).toEqual(initial[2])
    expect(chat.messages[1]?.native?.openaiCompatible).toHaveProperty("encrypted_content", "native-cipher")
  }),
)

offline.effect("771 removes defaults and http.body encryption includes, preserves other options", () =>
  Effect.gen(function* () {
    const sent: Record<string, unknown>[] = []
    const configured = request.model.route
      .with({ providerOptions: { openai: { include: ["reasoning.encrypted_content"], store: true } } })
      .model({ id: "local" })
    const stored = LLM.request({
      model: configured,
      messages: request.messages,
      http: { body: { include: ["reasoning.encrypted_content", "message.output_text.logprobs"], user: "keep-user" } },
    })
    yield* LLMClient.stream(stored).pipe(
      Stream.runCollect,
      Effect.provide(
        dynamicResponse(({ text, respond }) =>
          Effect.sync(() => {
            sent.push(JSON.parse(text))
            return sent.length === 1
              ? respond(JSON.stringify(rejected), { status: 400 })
              : respond(sseEvents(completed), { headers: { "content-type": "text/event-stream" } })
          }),
        ),
      ),
    )
    expect(sent).toHaveLength(2)
    expect(sent[1]?.include).toEqual(["message.output_text.logprobs"])
    expect(sent[1]?.user).toBe("keep-user")
    expect(sent[1]?.input).not.toContainEqual({ type: "item_reference", id: "rs_old" })
  }),
)

offline.effect("771 cancellation while recovery is pending does not resend", () =>
  Effect.gen(function* () {
    const waiting = yield* Deferred.make<void>()
    const never = yield* Deferred.make<void>()
    let attempts = 0
    const run = yield* LLMClient.stream(request).pipe(
      Stream.runCollect,
      Effect.provide(
        dynamicResponse(({ respond }) =>
          Effect.gen(function* () {
            attempts++
            if (attempts === 1) return respond(JSON.stringify(rejected), { status: 400 })
            yield* Deferred.succeed(waiting, undefined)
            yield* Deferred.await(never)
            return respond(sseEvents(completed))
          }),
        ),
      ),
      Effect.forkChild,
    )
    yield* Deferred.await(waiting)
    yield* Fiber.interrupt(run)
    expect(attempts).toBe(2)
  }),
)

testEffect(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))).live(
  "771 actual loopback HTTP keeps auth and returns one successful response",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const sent: { auth: string | null; body: Record<string, unknown> }[] = []
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(incoming) {
            sent.push({ auth: incoming.headers.get("authorization"), body: await incoming.json() })
            return sent.length === 1
              ? Response.json(rejected, { status: 400 })
              : new Response(sseEvents(completed), { headers: { "content-type": "text/event-stream" } })
          },
        })
        return { server, sent }
      }),
      ({ server, sent }) =>
        Effect.gen(function* () {
          const attempts: RequestExecutor.Attempt[] = []
          const model = request.model.route
            .with({ endpoint: { baseURL: server.url.toString() } })
            .model({ id: "local" })
          const events = yield* LLMClient.stream(LLM.updateRequest(request, { model })).pipe(
            Stream.provideService(RequestExecutor.AttemptObserver, (attempt) =>
              Effect.sync(() => {
                attempts.push(attempt)
              }),
            ),
            Stream.runCollect,
          )
          expect(sent).toHaveLength(2)
          expect(sent.map((item) => item.auth)).toEqual(["Bearer local-test", "Bearer local-test"])
          expect(sent[1]?.body.include).not.toContain("reasoning.encrypted_content")
          expect(events.filter((event) => event.type === "step-finish")).toHaveLength(1)
          expect(attempts.map((attempt) => attempt.phase)).toEqual(["start", "headers", "failed", "start", "headers"])
          expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(2)
        }),
      ({ server }) =>
        Effect.sync(() => {
          server.stop(true)
        }),
    ),
)

testEffect(fixture).effect("771 recovers once without encrypted reasoning and retains completed tools", () =>
  Effect.gen(function* () {
    bodies.length = 0
    const original = yield* LLMClient.prepare(request)
    const events = yield* LLMClient.stream(request).pipe(
      Stream.provideService(RequestExecutor.AutomaticRetries, false),
      Stream.runCollect,
    )
    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.include).toContain("reasoning.encrypted_content")
    expect(bodies[1]?.include).toEqual(["message.output_text.logprobs"])
    expect(bodies[1]?.input).toEqual(
      (bodies[0]?.input as { type: string }[]).filter((item) => item.type !== "reasoning"),
    )
    expect(bodies[1]?.reasoning).toEqual({ effort: "high" })
    expect(bodies[1]?.max_output_tokens).toBe(128000)
    expect(events.filter((event) => event.type === "provider-error")).toHaveLength(0)
    expect(events.filter((event) => event.type === "step-finish")).toHaveLength(1)
    expect((yield* LLMClient.prepare(request)).body).toEqual(original.body)
  }),
)
