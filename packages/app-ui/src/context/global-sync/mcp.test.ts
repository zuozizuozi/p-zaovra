import { describe, expect, test } from "bun:test"
import { completeMcpOAuth, toggleMcp } from "./mcp"

describe("toggleMcp", () => {
  test("runs the status action before refreshing the owning query", async () => {
    const calls: string[] = []
    const input = (status: "connected" | "needs_auth" | "disabled") => ({
      status,
      connect: async () => {
        calls.push("connect")
      },
      disconnect: async () => {
        calls.push("disconnect")
      },
      authenticate: async () => {
        calls.push("authenticate")
      },
      refresh: async () => {
        calls.push("refresh")
      },
    })

    await toggleMcp(input("connected"))
    expect(calls).toEqual(["disconnect", "refresh"])

    calls.length = 0
    await toggleMcp(input("needs_auth"))
    expect(calls).toEqual(["authenticate", "refresh"])

    calls.length = 0
    await toggleMcp(input("disabled"))
    expect(calls).toEqual(["connect", "refresh"])
  })
})

describe("completeMcpOAuth", () => {
  test("opens the authorization URL, waits for completion, and reconnects", async () => {
    const calls: string[] = []
    const statuses = [{ status: "pending" as const }, { status: "complete" as const }]
    const readiness = [false, true]
    await completeMcpOAuth({
      begin: async () => ({ attemptID: "attempt", url: "https://auth.example/authorize" }),
      open: (url) => calls.push(`open:${url}`),
      status: async () => statuses.shift() ?? { status: "complete" },
      ready: async () => readiness.shift() ?? true,
      connect: async () => {
        calls.push("connect")
      },
      delay: async () => {
        calls.push("delay")
      },
    })
    expect(calls).toEqual(["open:https://auth.example/authorize", "delay", "delay", "connect"])
  })

  test("does not reconnect after an authorization failure", async () => {
    let connected = false
    await expect(
      completeMcpOAuth({
        begin: async () => ({ attemptID: "attempt", url: "https://auth.example/authorize" }),
        open: () => {},
        status: async () => ({ status: "failed", message: "denied" }),
        connect: async () => {
          connected = true
        },
      }),
    ).rejects.toThrow("denied")
    expect(connected).toBe(false)
  })
})
