import { describe, expect, test } from "bun:test"
import { completeMcpOAuth } from "./mcp"

describe("completeMcpOAuth", () => {
  test("opens, polls, then reconnects", async () => {
    const calls: string[] = []
    const statuses = [{ status: "pending" as const }, { status: "complete" as const }]
    const readiness = [false, true]
    await completeMcpOAuth({
      begin: async () => ({ attemptID: "attempt", url: "https://auth.example" }),
      open: async (url) => calls.push(`open:${url}`),
      status: async () => statuses.shift() ?? { status: "complete" },
      ready: async () => readiness.shift() ?? true,
      connect: async () => {
        calls.push("connect")
      },
      delay: async () => {
        calls.push("delay")
      },
    })
    expect(calls).toEqual(["open:https://auth.example", "delay", "delay", "connect"])
  })
})
