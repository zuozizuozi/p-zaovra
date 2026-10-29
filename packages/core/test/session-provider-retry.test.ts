import { expect } from "bun:test"
import { RequestExecutor } from "@zaovra-ai/llm/route"
import { SessionRetry } from "@zaovra-ai/core/session/retry"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import throttle from "../../llm/test/fixture/cerebras-throttle.json"
import { it } from "./lib/effect"

// Official captured response: anomalyco/opencode@618b89066773e707601577230ba7211605c8b569.
it.effect("84-R1 keeps captured Cerebras throughput throttles retryable through the real executor", () =>
  Effect.gen(function* () {
    const error = yield* providerError(throttle, 429)
    expect(error.reason._tag).toBe("RateLimit")
    expect(error.retryAfterMs).toBe(60_000)
    const input = {
      error,
      attempt: 0,
      committed: true,
      operations: "settled" as const,
      cancelled: false,
      remainingMs: 120_000,
    }
    expect(SessionRetry.decide(input)).toMatchObject({
      action: "retry",
      category: "RateLimit",
      delayMs: 60_000,
      committed: true,
    })
    expect(SessionRetry.decide({ ...input, cancelled: true })).toMatchObject({ action: "stop", category: "cancelled" })
    expect(SessionRetry.decide({ ...input, operations: "unknown" })).toMatchObject({
      action: "stop",
      category: "operation",
    })
    expect(SessionRetry.decide({ ...input, remainingMs: 59_999 })).toMatchObject({ action: "stop", category: "budget" })
  }),
)

for (const sample of [
  { status: 429, code: "insufficient_quota", category: "QuotaExceeded" },
  { status: 429, code: "token_quota_exceeded", message: "insufficient_quota", category: "QuotaExceeded" },
  { status: 429, code: "billing_hard_limit_reached", category: "QuotaExceeded" },
  { status: 402, code: "insufficient_balance", category: "QuotaExceeded" },
  // This 403 already stops as Authentication; preserve its classification and permanent stop.
  { status: 403, code: "insufficient_user_quota", category: "Authentication" },
  { status: 400, code: "context_length_exceeded", category: "InvalidRequest" },
] as const)
  it.effect(`84-R1 retains permanent ${sample.code} despite Retry-After`, () =>
    Effect.gen(function* () {
      const error = yield* providerError(
        { error: { code: sample.code, message: "message" in sample ? sample.message : sample.code } },
        sample.status,
      )
      expect(error.reason._tag).toBe(sample.category)
      expect(
        SessionRetry.decide({
          error,
          attempt: 0,
          committed: false,
          operations: "settled",
          cancelled: false,
          remainingMs: 120_000,
        }),
      ).toMatchObject({ action: "stop", category: sample.category })
    }),
  )

function providerError(body: unknown, status: number) {
  return RequestExecutor.Service.use((executor) =>
    executor.execute(HttpClientRequest.post("https://provider.test/v1/chat/completions")),
  ).pipe(
    Effect.provide(
      RequestExecutor.layer.pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify(body), { status, headers: { "retry-after": "60" } }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    Effect.provideService(RequestExecutor.AutomaticRetries, false),
    Effect.flip,
  )
}
