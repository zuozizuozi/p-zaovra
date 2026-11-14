import { expect, test } from "bun:test"
import { SessionBudget } from "../src/session/budget"

const phase = { limit: 1000, total: 749, expired: false, reserveReached: false, notify: true }

for (const [total, expected] of [
  [0, "continue"],
  [749, "continue"],
  [750, "notice"],
  [751, "notice"],
  [999, "notice"],
  [1000, "expired"],
  [1001, "expired"],
] as const)
  test(`budget phase at ${total}/1000`, () => {
    expect(SessionBudget.phase({ ...phase, total })).toBe(expected)
  })

test("budget phase preserves no limit, zero limit and notify suppression", () => {
  expect(SessionBudget.phase({ ...phase, limit: undefined, total: 1000000 })).toBe("continue")
  expect(SessionBudget.phase({ ...phase, limit: 0, total: 0 })).toBe("expired")
  expect(SessionBudget.phase({ ...phase, total: 750, notify: false })).toBe("continue")
  expect(SessionBudget.phase({ ...phase, total: 1000, notify: false })).toBe("expired")
})

test("budget phase prioritizes token exhaustion over reached closing reserve", () => {
  expect(SessionBudget.phase({ ...phase, reserveReached: true })).toBe("closing")
  expect(SessionBudget.phase({ ...phase, reserveReached: true, limit: undefined })).toBe("closing")
  expect(SessionBudget.phase({ ...phase, reserveReached: true, total: 1000 })).toBe("expired")
  expect(SessionBudget.phase({ ...phase, reserveReached: true, total: 1001 })).toBe("expired")
  expect(SessionBudget.phase({ ...phase, expired: true })).toBe("expired")
  expect(SessionBudget.phase({ ...phase, expired: true, limit: undefined })).toBe("expired")
})

const window = {
  deadline: 1000,
  closingReserveMs: 100,
  elapsed: 999,
  duration: 1000,
  receipt: { providerDeadline: 800, deadline: 1000, closingReserveMs: 100 },
}

for (const elapsed of [999, 1000, 1001])
  test(`budget stop state retains wall boundary ${elapsed}`, () => {
    const stop = SessionBudget.stopState({ ...window, elapsed })
    expect(stop).toEqual({ providerAt: 800, expired: elapsed >= 1000 })
    expect(SessionBudget.phase({ ...phase, expired: stop.expired })).toBe(elapsed >= 1000 ? "expired" : "continue")
  })

test("budget stop state keeps explicit provider deadlines ahead of restored values", () => {
  expect(SessionBudget.stopState({ ...window, providerDeadline: 900 })).toEqual({ providerAt: 900, expired: false })
  expect(SessionBudget.stopState({ ...window, providerDeadline: 0 })).toEqual({ providerAt: 0, expired: false })
  expect(SessionBudget.stopState({ ...window, receipt: { ...window.receipt, providerDeadline: 0 } })).toEqual({
    providerAt: 0,
    expired: false,
  })
})

for (const [name, receipt] of [
  ["missing", undefined],
  ["null", null],
  ["string", "receipt"],
  ["wrong deadline", { ...window.receipt, deadline: 1001 }],
  ["wrong reserve", { ...window.receipt, closingReserveMs: 101 }],
  ["no deadline", { providerDeadline: 800, closingReserveMs: 100 }],
  ["no reserve", { providerDeadline: 800, deadline: 1000 }],
  ["nonnumeric provider", { ...window.receipt, providerDeadline: "800" }],
] as const)
  test(`budget stop state ignores incompatible receipt: ${name}`, () => {
    expect(SessionBudget.stopState({ ...window, receipt })).toEqual({ providerAt: undefined, expired: false })
  })

test("budget stop state preserves explicit stop and absence of duration", () => {
  expect(SessionBudget.stopState({ ...window, receipt: undefined, duration: undefined, stopMessage: "stop" })).toEqual({
    providerAt: undefined,
    expired: true,
  })
  expect(SessionBudget.stopState({ ...window, duration: undefined, stopMessage: "stop" })).toEqual({
    providerAt: 800,
    expired: false,
  })
  expect(SessionBudget.stopState({ ...window, receipt: undefined, duration: undefined, stopMessage: "" })).toEqual({
    providerAt: undefined,
    expired: false,
  })
  expect(SessionBudget.stopState({ ...window, duration: 0, elapsed: 0 })).toEqual({ providerAt: 800, expired: true })
})
