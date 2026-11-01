import { describe, expect, test } from "bun:test"
import { applyRunDuration, runDuration, runHostPolicy } from "@/cli/cmd/run/budget.shared"
import { createZaovraClient } from "@zaovra-ai/sdk/v2"

describe("run duration selection", () => {
  test("headless mode is explicit; no closing reserve is inferred and only a supplied absolute deadline enables it", () => {
    expect(runHostPolicy(false)).toEqual({ mode: "unattended" })
    expect(runHostPolicy(true)).toEqual({ mode: "interactive" })
    expect(runHostPolicy(false, 0, 0)).toEqual({ mode: "unattended", deadline: 0, closingReserveMs: 0 })
    expect(runHostPolicy(false, 12000, 1000)).toEqual({ mode: "unattended", deadline: 12000, closingReserveMs: 1000 })
    for (const value of [-1, 0.5, Infinity, NaN])
      expect(() => runHostPolicy(false, 12000, value)).toThrow("--closing-reserve-ms")
    expect(() => runHostPolicy(false, undefined, 1000)).toThrow("--closing-reserve-ms")
    expect(() => runHostPolicy(false, Infinity)).toThrow("--deadline-ms")
  })
  test("separates mode defaults, explicit unlimited and a positive duration", () => {
    expect(runDuration(undefined)).toBeUndefined()
    expect(runDuration("unlimited")).toEqual({ durationMs: null })
    expect(runDuration("900000")).toEqual({ durationMs: 900_000 })
    for (const value of ["", "0", "-1", "1.5", "Infinity", "NaN", "9007199254740992"]) {
      expect(() => runDuration(value)).toThrow("--duration-ms")
    }
  })

  test("adoption preserves an omitted limit and sends only the selected axis without resuming", async () => {
    const requests: Request[] = []
    const bodies: unknown[] = []
    const sdk = createZaovraClient({
      baseUrl: "http://budget.fixture",
      fetch: (async (input: RequestInfo | URL) => {
        const request = new Request(input)
        requests.push(request)
        bodies.push(await request.json())
        return Response.json({ data: {} })
      }) as typeof fetch,
    })
    await applyRunDuration(sdk, "ses_duration", runDuration(undefined))
    expect(requests).toHaveLength(0)
    await applyRunDuration(sdk, "ses_duration", runDuration("unlimited"))
    await applyRunDuration(sdk, "ses_duration", runDuration("60000"))
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["PATCH", "/api/session/ses_duration"],
      ["PATCH", "/api/session/ses_duration"],
    ])
    expect(bodies).toEqual([{ budget: { durationMs: null } }, { budget: { durationMs: 60_000 } }])
  })
})
