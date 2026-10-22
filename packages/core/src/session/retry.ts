export * as SessionRetry from "./retry"

import { LLMError } from "@zaovra-ai/llm"

export type Input = {
  error: LLMError
  attempt: number
  repeated?: number
  committed: boolean
  operations: "settled" | "unknown"
  remainingMs?: number
  cancelled: boolean
}

/** Recovery is session-owned; a timeout alone is not evidence of a transient connection failure. */
export function decide(input: Input) {
  if (input.cancelled) return { action: "stop" as const, category: "cancelled", message: "已停止重试。" }
  if (input.remainingMs !== undefined && input.remainingMs <= 0)
    return { action: "stop" as const, category: "budget", message: "墙钟预算已到期，已停止重试。" }
  if (input.operations === "unknown")
    return {
      action: "stop" as const,
      category: "operation",
      message: "工具效果不确定，已停止自动重试；请核对现场后继续。",
    }
  const reason = input.error.reason
  const permanent: Record<string, string> = {
    QuotaExceeded: "额度或余额不足，请检查套餐或切换提供商后继续。",
    Authentication: "鉴权或权限失败，请检查密钥和访问权限后继续。",
    InvalidRequest: "请求格式或参数不受支持，请修正请求或切换模型后继续。",
    NoRoute: "模型线路不可用，请修正配置后继续。",
    ContentPolicy: "内容被提供商过滤，请调整请求后继续。",
  }
  if (permanent[reason._tag]) return { action: "stop" as const, category: reason._tag, message: permanent[reason._tag] }
  const network =
    reason._tag === "Transport" &&
    (reason.kind === "StreamReadError" ||
      ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"].includes(
        reason.diagnostics?.causeCode ?? "",
      ))
  const transient = network || reason._tag === "RateLimit" || reason._tag === "ProviderInternal"
  if ((!transient && input.attempt >= 3) || (reason._tag === "ProviderInternal" && (input.repeated ?? 0) >= 3))
    return {
      action: "stop" as const,
      category: "environment",
      message: "同类错误已探测三次，等待环境或请求修正；可核对原因后继续。",
    }
  const delayMs = Math.max(
    [5_000, 10_000, 20_000, 40_000, 60_000][Math.min(input.attempt, 4)],
    input.error.retryAfterMs ?? 0,
  )
  if (input.remainingMs !== undefined && delayMs >= input.remainingMs)
    return { action: "stop" as const, category: "budget", message: "下次重试超过剩余墙钟预算，已按预算停止。" }
  return { action: "retry" as const, category: reason._tag, delayMs, committed: input.committed }
}
