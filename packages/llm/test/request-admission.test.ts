import { expect } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http"
import { LLM } from "../src"
import { configure } from "../src/providers/openai"
import { LLMError, QuotaExceededReason } from "../src/schema"
import { RequestExecutor } from "../src/route"
import { testEffect } from "./lib/effect"
import { runtimeLayer } from "./lib/http"

const it = testEffect(RequestExecutor.fetchLayer)
const exhausted = () =>
  new LLMError({
    module: "test/host-quota",
    method: "admit",
    reason: new QuotaExceededReason({ message: "No reserved budget remains" }),
  })

it.live("request admission defaults to the existing HTTP behavior", () =>
  Effect.gen(function* () {
    const received: string[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            received.push(request.method)
            return new Response("ok")
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const executor = yield* RequestExecutor.Service
    const response = yield* executor.execute(HttpClientRequest.post(server.url.href))
    expect(response.status).toBe(200)
    expect(yield* response.text).toBe("ok")
    expect(received).toEqual(["POST"])
  }),
)

it.live("request admission rejects before the HTTP request or attempt-start notification", () =>
  Effect.gen(function* () {
    const received: string[] = []
    const observed: RequestExecutor.Attempt[] = []
    const admitted: string[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            received.push(request.method)
            return new Response("unexpected")
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const executor = yield* RequestExecutor.Service
    const request = HttpClientRequest.post(server.url.href).pipe(HttpClientRequest.bodyText("bounded input"))
    const error = yield* executor.execute(request).pipe(
      Effect.provideService(RequestExecutor.RequestAdmission, (input) =>
        Effect.gen(function* () {
          admitted.push(input.id)
          expect(input.request).toBe(request)
          return yield* exhausted()
        }),
      ),
      Effect.provideService(RequestExecutor.AttemptObserver, (attempt) =>
        Effect.sync(() => {
          observed.push(attempt)
        }),
      ),
      Effect.flip,
    )
    expect(error.reason._tag).toBe("QuotaExceeded")
    expect(admitted).toHaveLength(1)
    expect(received).toHaveLength(0)
    expect(observed).toHaveLength(0)
  }),
)

for (const rejectRetry of [false, true]) {
  it.live(`request admission checks a status retry again (reject=${rejectRetry})`, () =>
    Effect.gen(function* () {
      const trace: string[] = []
      const admitted: string[] = []
      const started: string[] = []
      let received = 0
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch() {
              trace.push("http")
              received++
              return received === 1
                ? new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } })
                : new Response("ok")
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const executor = yield* RequestExecutor.Service
      const result = yield* executor.execute(HttpClientRequest.post(server.url.href)).pipe(
        Effect.provideService(RequestExecutor.RequestAdmission, ({ id }) =>
          Effect.gen(function* () {
            trace.push("admit")
            admitted.push(id)
            if (rejectRetry && admitted.length > 1) return yield* exhausted()
          }),
        ),
        Effect.provideService(RequestExecutor.AttemptObserver, (attempt) =>
          Effect.sync(() => {
            if (attempt.phase !== "start") return
            trace.push("start")
            started.push(attempt.id)
          }),
        ),
        Effect.map((response) => ({ status: response.status })),
        Effect.catch((error) => Effect.succeed({ error: error.reason._tag })),
      )
      expect(admitted).toHaveLength(2)
      expect(new Set(admitted).size).toBe(2)
      expect(started).toEqual(rejectRetry ? admitted.slice(0, 1) : admitted)
      expect(received).toBe(rejectRetry ? 1 : 2)
      expect(trace).toEqual(
        rejectRetry ? ["admit", "start", "http", "admit"] : ["admit", "start", "http", "admit", "start", "http"],
      )
      expect(result).toEqual(rejectRetry ? { error: "QuotaExceeded" } : { status: 200 })
    }),
  )
}

it.live("cancelling a pending admission sends no HTTP request", () =>
  Effect.gen(function* () {
    const received: string[] = []
    const entered = yield* Deferred.make<void>()
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            received.push(request.method)
            return new Response("unexpected")
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const executor = yield* RequestExecutor.Service
    const pending = yield* executor.execute(HttpClientRequest.post(server.url.href)).pipe(
      Effect.provideService(RequestExecutor.RequestAdmission, () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      ),
      Effect.forkChild,
    )
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(pending)
    expect(received).toHaveLength(0)
  }),
)

testEffect(runtimeLayer(FetchHttpClient.layer)).live(
  "compiled LLM requests must pass admission again before a retry",
  () =>
    Effect.gen(function* () {
      const received: string[] = []
      const bodies: string[] = []
      const ids: string[] = []
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
              received.push(await request.text())
              return new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } })
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const error = yield* LLM.generate(
        LLM.request({
          model: configure({ apiKey: "local-fixture", baseURL: server.url.href }).chat("admission-test"),
          prompt: "hello",
        }),
      ).pipe(
        Effect.provideService(RequestExecutor.RequestAdmission, (input) =>
          Effect.gen(function* () {
            ids.push(input.id)
            const request = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            bodies.push(yield* Effect.promise(() => request.text()))
            if (ids.length > 1) return yield* exhausted()
          }),
        ),
        Effect.flip,
      )
      expect(error.reason._tag).toBe("QuotaExceeded")
      expect(ids).toHaveLength(2)
      expect(new Set(ids).size).toBe(2)
      expect(bodies[0]).toBe(bodies[1])
      expect(JSON.parse(bodies[0])).toMatchObject({
        model: "admission-test",
        messages: [{ role: "user", content: "hello" }],
      })
      expect(received).toEqual([bodies[0]])
    }),
)

it.live("host manual-redirect policy prevents an unadmitted redirect request", () =>
  Effect.gen(function* () {
    const received: string[] = []
    const admitted: string[] = []
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(request) {
            const pathname = new URL(request.url).pathname
            received.push(pathname)
            return pathname === "/first"
              ? new Response(null, { status: 307, headers: { location: "/redirected" } })
              : new Response("unexpected")
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    const executor = yield* RequestExecutor.Service
    const response = yield* executor.execute(HttpClientRequest.post(new URL("/first", server.url).href)).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(RequestExecutor.AutomaticRetries, false),
      Effect.provideService(RequestExecutor.RequestAdmission, (input) =>
        Effect.sync(() => {
          admitted.push(input.id)
        }),
      ),
    )
    expect(response.status).toBe(307)
    expect(admitted).toHaveLength(1)
    expect(received).toEqual(["/first"])
  }),
)
