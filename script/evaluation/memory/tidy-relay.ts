import { createHash, randomUUID } from "node:crypto"

const fields = ["model", "input", "instructions", "tools", "tool_choice", "reasoning", "text"]

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  )
}

function fingerprint(body: Record<string, unknown>) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical(Object.fromEntries(fields.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]))),
      ),
    )
    .digest("hex")
}

export const isCountInput = (body: Record<string, unknown>) => Object.keys(body).every((key) => fields.includes(key))

export function createTidyRelay(input: {
  target: string
  apiKey: string
  maxCountRequests: number
  log(record: object): void
}) {
  type Scope = { taskID: string; sessionID: string; controller: AbortController }
  let current: Scope | undefined
  let used = false
  const counts: { id: string; status: number | null; inputTokens: number | null }[] = []
  const generations: string[] = []
  const permits = new Map<string, number>()
  const target = input.target + "/input_tokens"

  return {
    get current() {
      return current
    },
    get available() {
      return !used
    },
    open(binding: { taskID: string; sessionID: string }) {
      if (used || !/^[\w-]{1,120}$/.test(binding.taskID) || !/^ses_[a-zA-Z0-9]+$/.test(binding.sessionID))
        throw new Error("invalid-evaluation-tidy-authorization")
      const scope = { ...binding, controller: new AbortController() }
      input.log({ phase: "tidy-bound", ...binding })
      used = true
      current = scope
      return {
        [Symbol.dispose]() {
          current = undefined
          permits.clear()
          scope.controller.abort()
        },
      }
    },
    stop() {
      current?.controller.abort()
      current = undefined
      permits.clear()
    },
    evidence() {
      return {
        countLimit: input.maxCountRequests,
        countBilling: "unknown" as const,
        counts: structuredClone(counts),
        generationIDs: [...generations],
      }
    },
    consume(scope: Scope, body: Record<string, unknown>, id: string) {
      const digest = fingerprint(body)
      const available = permits.get(digest) ?? 0
      if (current !== scope || !available) return false
      permits.set(digest, available - 1)
      generations.push(id)
      return true
    },
    async count(scope: Scope, request: Request, bytes: Uint8Array<ArrayBuffer>, body: Record<string, unknown>) {
      if (current !== scope) return new Response(null, { status: 403 })
      if (counts.length >= input.maxCountRequests) return new Response(null, { status: 429 })
      const row = { id: randomUUID(), status: null as number | null, inputTokens: null as number | null }
      input.log({
        phase: "tidy-count-admitted",
        id: row.id,
        ordinal: counts.length + 1,
        taskID: scope.taskID,
        sessionID: scope.sessionID,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      })
      counts.push(row)
      try {
        const response = await fetch(target, {
          method: "POST",
          headers: {
            authorization: "Bearer " + input.apiKey,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: bytes,
          redirect: "error",
          signal: AbortSignal.any([request.signal, scope.controller.signal, AbortSignal.timeout(18_000)]),
        })
        row.status = response.status
        const chunks = []
        let size = 0
        const reader = response.body?.getReader()
        if (reader) {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.length
            if (size > 65_536) {
              await reader.cancel()
              throw new Error("count-response-limit")
            }
            chunks.push(chunk.value)
          }
        }
        const contents = Buffer.concat(chunks, size)
        if (response.status === 200 && current === scope) {
          const decoded = JSON.parse(contents.toString("utf8")) as { object?: unknown; input_tokens?: unknown }
          const tokens = decoded?.input_tokens
          if (
            decoded?.object === "response.input_tokens" &&
            typeof tokens === "number" &&
            Number.isSafeInteger(tokens) &&
            tokens > 0
          ) {
            row.inputTokens = tokens
            const digest = fingerprint(body)
            permits.set(digest, (permits.get(digest) ?? 0) + 1)
          }
        }
        return new Response(contents.length ? contents : null, {
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
        })
      } catch {
        return new Response(null, { status: 502 })
      } finally {
        input.log({ phase: "tidy-count-observed", ...row })
      }
    },
  }
}
