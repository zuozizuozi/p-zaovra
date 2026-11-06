import { describe, expect, test } from "bun:test"
import { isContextOverflow } from "../src"
import { providerFailure } from "../src/provider-error"

describe("provider error classification", () => {
  test("classifies Z.AI GLM token limit messages as context overflow", () => {
    expect(isContextOverflow("tokens in request more than max tokens allowed")).toBe(true)
  })

  test("classifies the official DashScope input-length range error", () => {
    // Official FAQ shape; numeric upper bound substitutes its 'xxx' placeholder.
    // https://help.aliyun.com/en/model-studio/coding-plan-faq
    const reason = providerFailure({
      status: 400,
      code: "InvalidParameter",
      message: "Range of input length should be [1, 16384]",
    })
    expect(reason._tag).toBe("InvalidRequest")
    expect("classification" in reason && reason.classification).toBe("context-overflow")
  })

  test("byte limits and unclassified HTTP errors do not imply token overflow", () => {
    for (const message of ["Request entity too large", "413 status code (no body)", "400 (no body)"]) {
      expect(isContextOverflow(message)).toBe(false)
      const reason = providerFailure({ status: 413, code: "request_too_large", message })
      expect(reason._tag).toBe("InvalidRequest")
      expect("classification" in reason && reason.classification).not.toBe("context-overflow")
    }
    expect(isContextOverflow("Range of output length should be [1, 16384]")).toBe(false)
    expect(isContextOverflow("Range of input length should be [4, 8]")).toBe(false)
    expect(isContextOverflow("maximum context length is 128000 tokens")).toBe(true)
    expect(isContextOverflow("context_length_exceeded")).toBe(true)
  })
})

for (const message of [
  "thinking_budget must not be greater than 131072",
  "thinking_budget should be less than 131073",
  "reasoning_effort is not supported for this model",
  "Unsupported parameter: thinking_budget",
])
  test("683 stops a named reasoning constraint: " + message, () => {
    const reason = providerFailure({ status: 502, code: "server_error", message })
    expect(reason).toMatchObject({
      _tag: "InvalidRequest",
      parameter: message.includes("reasoning_effort") ? "reasoning_effort" : "thinking_budget",
      retryable: false,
    })
    expect(reason.message).toContain("当前推理档位超出该模型或服务的上限，请降一档。")
  })

for (const input of [
  { status: 502, message: "Upstream thinking_budget connection failed", tag: "ProviderInternal" },
  {
    status: 502,
    message: "thinking_budget accepted, max_tokens must not be greater than 1024",
    tag: "ProviderInternal",
  },
  {
    status: 400,
    message: "maximum context length is 128000 tokens; thinking_budget must not be greater than 131072",
    tag: "InvalidRequest",
  },
  { status: 529, message: "thinking_budget must not be greater than 131072", tag: "ProviderInternal" },
  { status: 401, message: "thinking_budget must not be greater than 131072", tag: "Authentication" },
  { status: 429, message: "thinking_budget must not be greater than 131072", tag: "RateLimit" },
  { status: 502, message: "insufficient_quota; thinking_budget must not be greater than 131072", tag: "QuotaExceeded" },
  {
    status: 400,
    message: "maximum context length is 128000 tokens; thinking_budget was supplied",
    tag: "InvalidRequest",
  },
] as const)
  test("683 preserves adjacent error policy: " + input.message + " / " + input.status, () => {
    const reason = providerFailure(input)
    expect(reason._tag).toBe(input.tag)
    expect(reason.message).not.toContain("请降一档")
    if (input.status === 400) expect(reason).toMatchObject({ classification: "context-overflow" })
  })
