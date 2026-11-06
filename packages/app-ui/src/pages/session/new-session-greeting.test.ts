import { expect, test } from "bun:test"
import { newSessionGreeting } from "./new-session-greeting"
test("697 greetings follow the four local-time boundaries", () => {
  for (const [hour, period] of [
    [0, "evening"],
    [4, "evening"],
    [5, "morning"],
    [10, "morning"],
    [11, "noon"],
    [13, "noon"],
    [14, "afternoon"],
    [17, "afternoon"],
    [18, "evening"],
    [23, "evening"],
  ] as const)
    expect(newSessionGreeting(hour)).toBe("session.new.greeting." + period)
})
