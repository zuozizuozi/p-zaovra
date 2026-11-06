import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect"
import { adjust } from "effect/testing/TestClock"
import { providerProgress } from "../src/session/runner/provider-progress"
import { LLMError, TransportReason } from "@zaovra-ai/llm"
import { SessionRetry } from "../src/session/retry"
import { it } from "./lib/effect"

it.effect("705 preserves finite provider completion, empty completion and typed failures", () =>
  Effect.gen(function* () {
    expect(yield* Stream.fromIterable([1, 2, 3]).pipe(providerProgress, Stream.runCollect)).toEqual([1, 2, 3])
    expect(yield* Stream.empty.pipe(providerProgress, Stream.runCollect)).toEqual([])
    const failure = new LLMError({
      module: "test",
      method: "stream",
      reason: new TransportReason({ kind: "StreamReadError", message: "original failure" }),
    })
    const result = yield* Stream.fail(failure).pipe(providerProgress, Stream.runDrain, Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(failure)
  }),
)

it.effect("705 permits an active provider turn longer than the silence limit", () =>
  Effect.gen(function* () {
    const waiting = yield* Stream.range(1, 3).pipe(
      Stream.mapEffect((value) => Effect.sleep(80).pipe(Effect.as(value))),
      (stream) => providerProgress(stream, 100),
      Stream.runCollect,
      Effect.forkChild,
    )
    yield* adjust(240)
    expect(yield* Fiber.join(waiting)).toEqual([1, 2, 3])
  }),
)

it.effect("705 excludes downstream durable settlement from provider silence", () =>
  Effect.gen(function* () {
    const received: number[] = []
    const waiting = yield* Stream.fromIterable([1, 2]).pipe(
      (stream) => providerProgress(stream, 100),
      Stream.runForEach((value) => Effect.sleep(200).pipe(Effect.andThen(Effect.sync(() => received.push(value))))),
      Effect.forkChild,
    )
    yield* adjust(400)
    yield* Fiber.join(waiting)
    expect(received).toEqual([1, 2])
  }),
)

it.effect("701 a silent provider is cancelled and produces a readable timeout for buffered and streaming routes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let released = false
    const source = Stream.fromEffect(
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Effect.never
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            released = true
          }),
        ),
      ),
    )
    const waiting = yield* source.pipe(providerProgress, Stream.runDrain, Effect.exit, Effect.forkChild)
    yield* Deferred.await(started)
    yield* adjust("180 seconds")
    const result = yield* Fiber.join(waiting)
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("180 秒没有有效事件")
    expect(released).toBe(true)
    expect(
      SessionRetry.decide({
        error: new LLMError({
          module: "SessionRunner",
          method: "stream",
          reason: new TransportReason({ kind: "ProgressTimeout", message: "silent" }),
        }),
        attempt: 0,
        committed: false,
        operations: "settled",
        cancelled: false,
      }),
    ).toMatchObject({ action: "stop", category: "timeout" })
  }),
)

for (const turn of [2, 3]) {
  for (const mode of ["silent", "disconnect", "complete", "stop", "tool-stop"] as const) {
    it.effect(`707 turn ${turn} ${mode} releases its source and never repeats tool effects`, () =>
      Effect.gen(function* () {
        const opened: number[] = []
        const released: number[] = []
        const tools: number[] = []
        const started = yield* Deferred.make<void>()
        const toolStarted = yield* Deferred.make<void>()
        const failure = new LLMError({
          module: "test",
          method: "stream",
          reason: new TransportReason({ kind: "StreamReadError", message: "disconnected" }),
        })
        const run = yield* Effect.forEach(
          Array.from({ length: turn }, (_, index) => index + 1),
          (index) =>
            Stream.unwrap(
              Effect.gen(function* () {
                opened.push(index)
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    released.push(index)
                  }),
                )
                if (index !== turn) return Stream.make(index)
                yield* Deferred.succeed(started, undefined)
                if (mode === "silent" || mode === "stop") return Stream.fromEffect(Effect.never)
                if (mode === "disconnect") return Stream.concat(Stream.make(index), Stream.fail(failure))
                return Stream.make(index)
              }),
            ).pipe(
              providerProgress,
              Stream.runForEach((value) => {
                tools.push(value)
                if (index !== turn || mode !== "tool-stop") return Effect.void
                return Deferred.succeed(toolStarted, undefined).pipe(Effect.andThen(Effect.never))
              }),
            ),
          { concurrency: 1 },
        ).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(started)
        if (mode === "silent") yield* adjust("180 seconds")
        if (mode === "stop") yield* Fiber.interrupt(run)
        if (mode === "tool-stop") {
          yield* Deferred.await(toolStarted)
          yield* adjust("181 seconds")
          expect(released).toEqual(Array.from({ length: turn - 1 }, (_, index) => index + 1))
          yield* Fiber.interrupt(run)
        }
        const result = yield* Fiber.join(run).pipe(Effect.exit)
        expect(opened).toEqual(Array.from({ length: turn }, (_, index) => index + 1))
        expect(released).toEqual(opened)
        expect(tools).toEqual(
          Array.from({ length: mode === "silent" || mode === "stop" ? turn - 1 : turn }, (_, index) => index + 1),
        )
        if (mode === "complete") expect(result).toMatchObject({ _tag: "Success", value: { _tag: "Success" } })
        if (mode === "disconnect" && Exit.isSuccess(result) && Exit.isFailure(result.value))
          expect(Cause.squash(result.value.cause)).toBe(failure)
        if (mode === "silent") {
          expect(result).toMatchObject({ _tag: "Success", value: { _tag: "Failure" } })
          if (Exit.isSuccess(result) && Exit.isFailure(result.value))
            expect(Cause.pretty(result.value.cause)).toContain("180 秒没有有效事件")
        }
        if (mode === "stop" || mode === "tool-stop") expect(Exit.isFailure(result)).toBe(true)
      }),
    )
  }
}
