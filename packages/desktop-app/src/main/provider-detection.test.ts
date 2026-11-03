import { expect, test } from "bun:test"
import { detectProviderProtocol, providerServiceKey, providerPresetProtocol } from "@zaovra-ai/app/provider-discovery"

test("normalizes duplicate endpoint forms", () => {
  expect(providerServiceKey("https://API.GRAVITEX.AI/v1/responses/")).toBe(providerServiceKey("api.gravitex.ai/v1"))
})
test("recognizes known vendor protocols before model discovery", () => {
  expect(providerPresetProtocol("generativelanguage.googleapis.com")).toBe("google")
  expect(providerPresetProtocol("https://api.anthropic.com/v1")).toBe("anthropic")
  expect(providerPresetProtocol("https://api.deepseek.com/v1")).toBe("openai")
})
for (const status of [404, 405, 501, 400]) {
  test(`falls back from unavailable Responses (${status}) to Chat for the selected model`, async () => {
    const calls: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        calls.push(pathname)
        expect((await request.json()).model).toBe("test-model")
        if (pathname.endsWith("/responses"))
          return Response.json({ error: { message: "Responses not supported" } }, { status })
        return Response.json({ choices: [] })
      },
    })
    try {
      expect(
        await detectProviderProtocol({ baseURL: server.url.href, apiKey: "local-only", modelID: "test-model" }),
      ).toBe("openai")
      expect(calls).toEqual(["/v1/responses", "/v1/chat/completions"])
    } finally {
      server.stop(true)
    }
  })
}
for (const status of [400, 401, 403, 429, 500]) {
  test(`does not fall back on unrelated HTTP ${status}`, async () => {
    let calls = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        calls++
        return Response.json({ error: { message: "unrelated failure" } }, { status })
      },
    })
    try {
      await expect(
        detectProviderProtocol({ baseURL: server.url.href, apiKey: "local-only", modelID: "test" }),
      ).rejects.toThrow(`HTTP ${status}`)
      expect(calls).toBe(1)
    } finally {
      server.stop(true)
    }
  })
}
test("accepts Responses immediately and uses known provider presets without network probes", async () => {
  let calls = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++
      return Response.json({ output: [] })
    },
  })
  try {
    expect(await detectProviderProtocol({ baseURL: server.url.href, apiKey: "", modelID: "test" })).toBe("responses")
    expect(calls).toBe(1)
    expect(await detectProviderProtocol({ baseURL: "https://api.deepseek.com/v1", apiKey: "", modelID: "test" })).toBe(
      "openai",
    )
  } finally {
    server.stop(true)
  }
})
