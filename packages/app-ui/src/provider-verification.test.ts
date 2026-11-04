import { expect, test } from "bun:test"
import { providerRequestSucceeded, providerVerificationToken } from "./provider-verification"
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
