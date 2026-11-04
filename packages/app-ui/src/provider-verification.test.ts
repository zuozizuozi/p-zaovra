import { expect, test } from "bun:test"
import {
  createProviderVerification,
  providerRequestSucceeded,
  providerVerificationToken,
} from "./provider-verification"
import type { Provider } from "@zaovra-ai/sdk/v2/client"

test("saved credentials and static model inventory alone are never proof of authentication", () => {
  for (const value of [
    { role: "user", time: { created: 2, completed: 3 }, finish: "stop" },
    { role: "assistant", time: { created: 2 } },
    { role: "assistant", time: { created: 2, completed: 3 }, error: { statusCode: 401 }, finish: "stop" },
    { role: "assistant", time: { created: 2, completed: 3 }, finish: "error" },
    { role: "assistant", time: { created: 0, completed: 3 }, finish: "stop" },
  ])
    expect(providerRequestSucceeded(value, 1)).toBe(false)
  expect(providerRequestSucceeded({ role: "assistant", time: { created: 2, completed: 3 }, finish: "stop" }, 1)).toBe(
    true,
  )
})

test("only an observed provider request can verify the current credential and endpoint", () => {
  let identity = "credential-A/endpoint-A"
  const verify = createProviderVerification(() => identity, 10)
  const started = { id: "request-A", providerID: "provider", role: "assistant", time: { created: 11 } }
  const ended = { ...started, time: { created: 11, completed: 12 }, finish: "stop" }
  expect(verify(ended)).toBeUndefined() // historical/reloaded completion
  expect(verify(started)).toBeUndefined()
  expect(verify(ended)).toEqual({ providerID: "provider", token: identity })
  expect(verify(ended)).toBeUndefined() // duplicate terminal event
  verify({ ...started, id: "old-key" })
  identity = "credential-B/endpoint-A"
  expect(verify({ ...ended, id: "old-key" })).toBeUndefined()
  verify({ ...started, id: "old-endpoint" })
  identity = "credential-B/endpoint-B"
  expect(verify({ ...ended, id: "old-endpoint", error: { statusCode: 401 } })).toBeUndefined()
  verify({ ...started, id: "current-failure" })
  expect(verify({ ...ended, id: "current-failure", error: { statusCode: 401 } })).toEqual({
    providerID: "provider",
    token: "",
  })
  const restarted = createProviderVerification(() => identity, 20)
  expect(restarted(ended)).toBeUndefined()
  verify({ ...started, id: "other-provider" })
  expect(verify({ ...ended, id: "other-provider", providerID: "other" })).toBeUndefined()
})

test("replacement credentials or endpoint configuration cannot reuse previous verification", () => {
  const provider = { options: { connectionIDs: ["cred_first"] } } as unknown as Provider
  const token = providerVerificationToken(provider, {
    options: { baseURL: "https://fixture.invalid", apiKey: "test-only" },
  })
  expect(
    providerVerificationToken(
      { ...provider, options: { connectionIDs: ["cred_replacement"] } },
      { options: { baseURL: "https://fixture.invalid", apiKey: "test-only" } },
    ),
  ).not.toBe(token)
  expect(
    providerVerificationToken(provider, { options: { baseURL: "https://other.invalid", apiKey: "test-only" } }),
  ).not.toBe(token)
  expect(
    providerVerificationToken(provider, { options: { baseURL: "https://fixture.invalid", apiKey: "other-test" } }),
  ).not.toBe(token)
  expect(providerVerificationToken(undefined, {})).toBe("")
})
