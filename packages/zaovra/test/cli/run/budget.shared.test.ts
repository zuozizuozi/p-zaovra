import { describe, expect, test } from "bun:test"
import { applyRunDuration, runDuration } from "@/cli/cmd/run/budget.shared"
import { createZaovraClient } from "@zaovra-ai/sdk/v2"

describe("run duration selection", () => {
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
