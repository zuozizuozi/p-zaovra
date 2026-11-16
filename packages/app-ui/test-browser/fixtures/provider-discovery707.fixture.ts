import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { discoverProviderModels } from "../../src/provider-discovery"
import { validateCustomProvider, modelRow } from "../../src/components/dialog-custom-provider-form"

test("707 real discovery 404, timeout and environment references retain a manual configuration path without generation", async () => {
  expect(typeof window).toBe("undefined")
  expect(fetch.toString()).toContain("[native code]")
  const requests: string[] = []
  const pending = Promise.withResolvers<void>()
  let mode = "404"
  const server = createServer(async (request, response) => {
    requests.push(request.method + " " + request.url)
    response.setHeader("Access-Control-Allow-Origin", "*")
    response.setHeader("Access-Control-Allow-Headers", "*")
    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
    if (request.method === "OPTIONS") {
      response.writeHead(204)
      response.end()
      return
    }
    if (mode === "timeout" && request.url?.endsWith("/models")) await pending.promise
    response.writeHead(404)
    response.end("unsupported")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing synthetic address")
  try {
    const baseURL = `http://127.0.0.1:${address.port}/v1`
    await expect(discoverProviderModels({ baseURL, apiKey: "synthetic" })).rejects.toThrow("http404")
    mode = "timeout"
    const began = performance.now()
    await expect(discoverProviderModels({ baseURL, apiKey: "synthetic" })).rejects.toThrow()
    const elapsed = performance.now() - began
    // Exercise the unchanged 15-second signal, not an immediate HTTP error fixture.
    expect(elapsed).toBeGreaterThanOrEqual(14_000)
    console.log("707 native discovery timeout ms=" + Math.round(elapsed))
    const before = requests.length
    await expect(discoverProviderModels({ baseURL, apiKey: "{env:SYNTHETIC_707_KEY}" })).rejects.toThrow("environment")
    expect(requests.length).toBe(before)
    for (const apiKey of ["synthetic", "{env:SYNTHETIC_707_KEY}"]) {
      const result = validateCustomProvider({
        form: {
          providerID: "manual",
          name: "Manual",
          baseURL,
          apiKey,
          protocol: "responses",
          models: [{ ...modelRow(), id: "concrete", name: "Concrete" }],
          headers: [],
          err: {},
        },
        t: (key) => key,
        disabledProviders: [],
        existingProviderIDs: new Set(),
      }).result
      expect(result?.config.models.concrete).toBeDefined()
      expect(result?.config.npm).toBe("@ai-sdk/openai")
      expect(result?.config.env).toEqual(apiKey.startsWith("{env:") ? ["SYNTHETIC_707_KEY"] : undefined)
    }
    expect(requests.every((request) => /^(GET|OPTIONS) /.test(request))).toBe(true)
    console.log("707 synthetic discovery requests=" + requests.length + ", generation POST=0")
  } finally {
    pending.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(server.listening).toBe(false)
  }
}, 20000)
