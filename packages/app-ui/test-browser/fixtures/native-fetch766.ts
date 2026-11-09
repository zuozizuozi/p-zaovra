// Use Bun's real HTTP transport; this DOM fixture does not simulate browser CORS.
export const request: typeof fetch = async (input, init) => {
  if (typeof input === "string" || input instanceof URL) return Bun.fetch(String(input), init)
  // Happy DOM's AbortSignal is a different realm; this bounded protocol fixture has no abort input.
  return Bun.fetch(input.url, {
    method: input.method,
    headers: Object.fromEntries(input.headers.entries()),
    ...(input.method === "GET" || input.method === "HEAD" ? {} : { body: await input.text() }),
  })
}
