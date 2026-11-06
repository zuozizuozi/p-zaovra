import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Stream } from "effect"
import { adjust } from "effect/testing/TestClock"
import { providerProgress } from "../src/session/runner/provider-progress"
import { LLMError, TransportReason } from "@zaovra-ai/llm"
import { SessionRetry } from "../src/session/retry"
import { it } from "./lib/effect"
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
