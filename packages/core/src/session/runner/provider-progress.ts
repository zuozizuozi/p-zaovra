import { Effect, Stream } from "effect"
import { LLMError, TransportReason } from "@zaovra-ai/llm"
/** Bound silent requests for both streaming and buffered HTTP transports. */
export function providerProgress<A, E, R>(stream: Stream.Stream<A, E, R>, timeoutMs = 180_000) {
  // Time only upstream pulls. A background merge changes provider delivery and
  // can keep a finished turn alive while its consumer settles durable events.
  return Stream.transformPull(stream, (pull) =>
    Effect.succeed(
      pull.pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(
              new LLMError({
                module: "SessionRunner",
                method: "stream",
                reason: new TransportReason({
                  kind: "ProgressTimeout",
                  message: `模型连接连续 ${timeoutMs / 1000} 秒没有有效事件；请求已停止。可检查模型服务状态后重新发送。`,
                }),
              }),
            ),
        }),
      ),
    ),
  )
}
