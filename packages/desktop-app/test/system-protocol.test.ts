import { expect, test } from "bun:test"
import { DEEP_LINK_PROTOCOLS } from "@zaovra-ai/app/deep-link-protocol"
import { registerSystemProtocol } from "../src/main/system-protocol"

test.each(Object.entries(DEEP_LINK_PROTOCOLS))(
  "normal %s profile registers its channel scheme",
  (_channel, protocol) => {
    const calls: string[] = []
    const result = registerSystemProtocol({
      protocol,
      explicitProfile: false,
      onboardingTest: false,
      register: (scheme) => {
        calls.push(scheme)
        return true
      },
    })
    expect(calls).toEqual([protocol])
    expect(result).toBe(true)
  },
)

test.each([
  [true, false],
  [false, true],
  [true, true],
])("isolated profile skips OS registration: explicit=%s onboarding=%s", (explicitProfile, onboardingTest) => {
  const calls: string[] = []
  registerSystemProtocol({
    protocol: DEEP_LINK_PROTOCOLS.beta,
    explicitProfile,
    onboardingTest,
    register: (scheme) => {
      calls.push(scheme)
      throw new Error("OS protocol registration must remain untouched")
    },
  })
  expect(calls).toEqual([])
})

test("a normal registration failure is preserved", () => {
  expect(
    registerSystemProtocol({
      protocol: DEEP_LINK_PROTOCOLS.dev,
      explicitProfile: false,
      onboardingTest: false,
      register: () => false,
    }),
  ).toBe(false)
})
