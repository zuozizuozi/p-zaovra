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
