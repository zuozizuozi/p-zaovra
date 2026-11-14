import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect"
import { adjust } from "effect/testing/TestClock"
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http"
import { LLM, LLMError, Message, QuotaExceededReason, TransportReason } from "../src"
import { configure } from "../src/providers/openai"
import { RequestExecutor } from "../src/route"
import { it, testEffect } from "./lib/effect"
import { dynamicResponse, runtimeLayer } from "./lib/http"
import { sseEvents } from "./lib/sse"

const http = testEffect(runtimeLayer(FetchHttpClient.layer))
const serve = (fetch: (request: Request) => Response | Promise<Response>) =>
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })),
    (server) => Effect.sync(() => server.stop(true)),
  )
const request = (baseURL: string, model = "receipt-test") =>
  LLM.request({ model: configure({ apiKey: "local-fixture", baseURL }).chat(model), prompt: "hello" })
const completed = (usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }) =>
  sseEvents({ choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage })

http.live("executor receipt is the successful physical attempt, not the failed status retry", () =>
  Effect.gen(function* () {
    let received = 0
    const admitted: string[] = []
    const observed: RequestExecutor.Attempt[] = []
    const server = yield* serve(() =>
      ++received === 1 ? new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }) : new Response("ok"),
    )
    const executor = yield* RequestExecutor.Service
    const attempt = yield* executor.executeAttempt(HttpClientRequest.post(server.url.href)).pipe(
      Effect.provideService(RequestExecutor.RequestAdmission, ({ id }) =>
        Effect.sync(() => {
          admitted.push(id)
        }),
      ),
      Effect.provideService(RequestExecutor.AttemptObserver, (event) =>
        Effect.sync(() => {
          observed.push(event)
        }),
      ),
    )
    expect(admitted).toHaveLength(2)
    expect(new Set(admitted).size).toBe(2)
    expect(attempt.id).toBe(admitted[1])
    expect(yield* attempt.response.text).toBe("ok")
    expect(observed.filter((event) => event.phase === "start").map((event) => event.id)).toEqual(admitted)
    expect(observed.filter((event) => event.phase === "failed").map((event) => event.id)).toEqual(admitted.slice(0, 1))
  }),
)

for (const retry of [false, true]) {
  http.live(`parser completion binds usage once to its own successful receipt (status retry=${retry})`, () =>
    Effect.gen(function* () {
      let received = 0
      const admitted: string[] = []
      const observations: RequestExecutor.Attempt[] = []
      const results: RequestExecutor.CompletedAttempt[] = []
      const server = yield* serve(() => {
        received++
        if (retry && received === 1) return new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } })
        return new Response(
          completed({
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            prompt_tokens_details: { cached_tokens: 4 },
            completion_tokens_details: { reasoning_tokens: 3 },
          }),
        )
      })
      const events = yield* LLM.stream(request(server.url.href)).pipe(
        Stream.runCollect,
        Effect.provideService(RequestExecutor.RequestAdmission, ({ id }) =>
          Effect.sync(() => {
            admitted.push(id)
          }),
        ),
        Effect.provideService(RequestExecutor.AttemptObserver, (event) =>
          Effect.sync(() => {
            observations.push(event)
          }),
        ),
        Effect.provideService(RequestExecutor.RequestCompletion, (result) =>
          Effect.sync(() => {
            results.push(result)
          }),
        ),
      )
      expect(admitted).toHaveLength(retry ? 2 : 1)
      expect(results).toHaveLength(1)
      expect(results.map((result) => result.id)).toEqual(admitted.slice(-1))
      expect(results[0]?.usage).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadInputTokens: 4,
        reasoningTokens: 3,
      })
      expect(results[0]?.usage?.providerMetadata).toMatchObject({ openai: { prompt_tokens: 10, completion_tokens: 5 } })
      expect(events.filter((event) => event.type === "step-finish")).toHaveLength(1)
      expect(events.filter((event) => event.type === "finish")).toHaveLength(1)
      expect(observations.filter((event) => event.phase === "start").map((event) => event.id)).toEqual(admitted)
      expect(admitted.filter((id) => !results.some((result) => result.id === id))).toEqual(
        retry ? admitted.slice(0, 1) : [],
      )
    }),
  )
}

http.live("concurrent streams keep receipt and usage ownership despite reverse completion order", () =>
  Effect.gen(function* () {
    const admissions = new Map<string, string>()
    const results: RequestExecutor.CompletedAttempt[] = []
    const second = Promise.withResolvers<void>()
    const server = yield* serve(async (incoming) => {
      const body = (await incoming.json()) as { model: string }
      if (body.model === "first") await second.promise
      return new Response(completed({ prompt_tokens: body.model === "first" ? 21 : 32, completion_tokens: 2 }))
    })
    yield* Effect.all(
      ["first", "second"].map((model) => LLM.generate(request(server.url.href, model))),
      { concurrency: 2 },
    ).pipe(
      Effect.provideService(RequestExecutor.RequestAdmission, ({ id, request }) =>
        Effect.gen(function* () {
          const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
          const body = yield* Effect.promise(() => web.json() as Promise<{ model: string }>)
          admissions.set(body.model, id)
        }),
      ),
      Effect.provideService(RequestExecutor.RequestCompletion, (result) =>
        Effect.sync(() => {
          results.push(result)
          if (result.request.model.id === "second") second.resolve()
        }),
      ),
    )
    expect(admissions.size).toBe(2)
    expect(new Set(admissions.values()).size).toBe(2)
    expect(results).toHaveLength(2)
    expect(results.map((result) => String(result.request.model.id))).toEqual(["second", "first"])
    for (const result of results) {
      const admitted = admissions.get(result.request.model.id)
      if (admitted === undefined) throw new Error("Completion has no admitted model")
      expect(result.id).toBe(admitted)
      expect(result.usage?.inputTokens).toBe(result.request.model.id === "first" ? 21 : 32)
    }
  }),
)

http.live("partial usage remains partial evidence rather than a fabricated complete bill", () =>
  Effect.gen(function* () {
    const results: RequestExecutor.CompletedAttempt[] = []
    const server = yield* serve(() => new Response(completed({ prompt_tokens: 10 })))
    yield* LLM.generate(request(server.url.href)).pipe(
      Effect.provideService(RequestExecutor.RequestCompletion, (result) =>
        Effect.sync(() => {
          results.push(result)
        }),
      ),
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.usage?.inputTokens).toBe(10)
    expect(results[0]?.usage?.outputTokens).toBeUndefined()
    expect(results[0]?.usage?.providerMetadata).toMatchObject({ openai: { prompt_tokens: 10 } })
  }),
)

for (const stop of ["early", "cancel"] as const) {
  http.live(`a ${stop} consumer leaves its admitted request without a completion callback`, () =>
    Effect.gen(function* () {
      const admitted: string[] = []
      const results: RequestExecutor.CompletedAttempt[] = []
      const entered = yield* Deferred.make<void>()
      const server = yield* serve(
        () =>
          new Response(
            stop === "early"
              ? completed()
              : new ReadableStream({
                  start(controller) {
                    controller.enqueue(
                      new TextEncoder().encode('data: {"choices":[{"delta":{"content":"started"}}]}\n\n'),
                    )
                  },
                }),
          ),
      )
      const stream = LLM.stream(request(server.url.href)).pipe(
        Stream.provideService(RequestExecutor.RequestAdmission, ({ id }) =>
          Effect.sync(() => {
            admitted.push(id)
          }),
        ),
        Stream.provideService(RequestExecutor.RequestCompletion, (result) =>
          Effect.sync(() => {
            results.push(result)
          }),
        ),
      )
      if (stop === "early") yield* stream.pipe(Stream.take(1), Stream.runDrain)
      if (stop === "cancel") {
        const fiber = yield* stream.pipe(
          Stream.tap(() => Deferred.succeed(entered, undefined)),
          Stream.runDrain,
          Effect.forkChild,
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
      }
      expect(admitted).toHaveLength(1)
      expect(results).toEqual([])
    }),
  )
}

for (const mode of ["quota", "transport", "defect"] as const) {
  http.live(`completion ${mode} failure stops the logical request without replaying HTTP`, () =>
    Effect.gen(function* () {
      let received = 0
      let completions = 0
      const failure =
        mode === "defect"
          ? new Error("settlement defect")
          : new LLMError({
              module: "host-budget",
              method: "settle",
              reason:
                mode === "quota"
                  ? new QuotaExceededReason({ message: "settlement failed" })
                  : new TransportReason({ kind: "StreamReadError", message: "settlement transport failed" }),
            })
      const server = yield* serve(() => {
        received++
        return new Response(completed())
      })
      const exit = yield* LLM.generate(request(server.url.href)).pipe(
        Effect.provideService(RequestExecutor.RequestCompletion, () =>
          Effect.suspend(() => {
            completions++
            return failure instanceof LLMError ? Effect.fail(failure) : Effect.die(failure)
          }),
        ),
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(
          exit.cause.reasons.some((reason) =>
            Cause.isFailReason(reason)
              ? reason.error === failure
              : Cause.isDieReason(reason) && reason.defect === failure,
          ),
        ).toBe(true)
      expect(received).toBe(1)
      expect(completions).toBe(1)
    }),
  )
}

http.live("encrypted-content recovery gives the successful recompiled request its own receipt", () =>
  Effect.gen(function* () {
    const ids: string[] = []
    const results: RequestExecutor.CompletedAttempt[] = []
    const bodies: string[] = []
    const server = yield* serve(async (incoming) => {
      bodies.push(await incoming.text())
      if (bodies.length === 1)
        return new Response(
          JSON.stringify({
            error: { code: "invalid_encrypted_content", type: "invalid_request_error", message: "cipher rejected" },
          }),
          { status: 400 },
        )
      return new Response(
        sseEvents({
          type: "response.completed",
          response: {
            id: "response-ok",
            status: "completed",
            output: [],
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        }),
      )
    })
    yield* LLM.generate(
      LLM.request({
        model: configure({ apiKey: "local-fixture", baseURL: server.url.href }).responses("receipt-test"),
        messages: [
          Message.user("hello"),
          Message.assistant([
            {
              type: "reasoning",
              text: "summary",
              providerMetadata: { openai: { itemId: "rs_old", reasoningEncryptedContent: "local-cipher" } },
            },
          ]),
          Message.user("continue"),
        ],
      }),
    ).pipe(
      Effect.provideService(RequestExecutor.RequestAdmission, ({ id }) =>
        Effect.sync(() => {
          ids.push(id)
        }),
      ),
      Effect.provideService(RequestExecutor.RequestCompletion, (result) =>
        Effect.sync(() => {
          results.push(result)
        }),
      ),
    )
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(results).toHaveLength(1)
    expect(results[0]?.id).toBe(ids[1])
    expect(results[0]?.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 })
    expect(bodies[0]).toContain("local-cipher")
    expect(bodies[1]).not.toContain("local-cipher")
  }),
)

it.effect("pre-output read recovery cannot attribute final usage to the disconnected receipt", () =>
  Effect.gen(function* () {
    let sent = 0
    const ids: string[] = []
    const results: RequestExecutor.CompletedAttempt[] = []
    const waiting = yield* Deferred.make<void>()
    const fiber = yield* LLM.generate(request("https://local-fixture.invalid/v1")).pipe(
      Effect.provide(
        dynamicResponse(({ respond }) =>
          Effect.sync(() => {
            sent++
            return respond(
              sent === 1
                ? new ReadableStream({
                    start(controller) {
                      controller.error(new Error("reset"))
                    },
                  })
                : completed(),
            )
          }),
        ),
      ),
      Effect.provideService(RequestExecutor.RetryObserver, () =>
        Deferred.succeed(waiting, undefined).pipe(Effect.asVoid),
      ),
      Effect.provideService(RequestExecutor.RequestAdmission, ({ id }) =>
        Effect.sync(() => {
          ids.push(id)
        }),
      ),
      Effect.provideService(RequestExecutor.RequestCompletion, (result) =>
        Effect.sync(() => {
          results.push(result)
        }),
      ),
      Effect.forkChild,
    )
    yield* Deferred.await(waiting)
    yield* adjust("30 seconds")
    yield* Fiber.join(fiber)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(results).toHaveLength(1)
    expect(results[0]?.id).toBe(ids[1])
  }),
)

it.effect("a read failure after reported usage still leaves completion unknown", () =>
  Effect.gen(function* () {
    const results: RequestExecutor.CompletedAttempt[] = []
    const ids: string[] = []
    const exit = yield* LLM.generate(request("https://local-fixture.invalid/v1")).pipe(
      Effect.provide(
        dynamicResponse(({ respond }) =>
          Effect.sync(() => {
            let first = true
            return respond(
              new ReadableStream(
                {
                  pull(controller) {
                    if (!first) return controller.error(new Error("reset after usage"))
                    first = false
                    controller.enqueue(
                      new TextEncoder().encode(
                        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
                      ),
                    )
                  },
                },
                { highWaterMark: 0 },
              ),
            )
          }),
        ),
      ),
      Effect.provideService(RequestExecutor.AutomaticRetries, false),
      Effect.provideService(RequestExecutor.RequestAdmission, ({ id }) =>
        Effect.sync(() => {
          ids.push(id)
        }),
      ),
      Effect.provideService(RequestExecutor.RequestCompletion, (result) =>
        Effect.sync(() => {
          results.push(result)
        }),
      ),
      Effect.exit,
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(ids).toHaveLength(1)
    expect(results).toEqual([])
  }),
)
