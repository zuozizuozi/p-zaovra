// Offline only. Uses the production summary request builder and transport encoder;
// reads no credentials, sends no requests, and executes no model-returned tools.
import { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLMClient } from "@zaovra-ai/llm/route"
import { OpenAICompatibleChat } from "@zaovra-ai/llm/protocols/openai-compatible-chat"
import type { HttpPrepared } from "../../llm/src/route/transport/http"
import { SessionCompaction } from "../src/session/compaction"
import { createHash } from "node:crypto"
import path from "node:path"

const root = process.argv[2]
if (!root) throw new Error("Expected a B1 evidence directory")
const registration = (await Bun.file(path.join(root, "registration.json")).json()) as { model: string }
const results = (await Bun.file(path.join(root, "results.json")).json()) as { id: string; directory: string }[]
const output = path.join(path.dirname(root), `compaction-b2-prepared-${Date.now()}`)
const model = OpenAICompatibleChat.route
  .with({ endpoint: { baseURL: "https://offline.invalid/v1" } })
  .model({ id: registration.model, provider: "offline" })
const cases = []
for (const row of results) {
  const calls = (await Bun.file(path.join(row.directory, "provider/calls.json")).json()) as {
    index: number
    settings: { max_tokens?: number }
    usage?: { total_tokens?: number }
  }[]
  for (const call of calls.filter((call) => call.settings.max_tokens === 4096)) {
    const original = path.join(row.directory, `provider/${call.index}-request.json`)
    const bytes = await Bun.file(original).text()
    const body = JSON.parse(bytes) as { messages: { role: string; content: string }[] }
    if (body.messages.length !== 1 || body.messages[0].role !== "user" || typeof body.messages[0].content !== "string")
      throw new Error("Unexpected archived summary request; refuse approximate replay")
    const request = SessionCompaction.summaryRequest({ model, prompt: body.messages[0].content, maxTokens: 4096 })
    const prepared = await Effect.runPromise(LLMClient.prepare<Record<string, unknown>>(request))
    const transport = (await Effect.runPromise(
      model.route.prepareTransport(prepared.body, request),
    )) as HttpPrepared<unknown>
    const web = await Effect.runPromise(HttpClientRequest.toWeb(transport.request))
    const wire = (await web.json()) as {
      model: string
      messages: { role: string; content: string }[]
      max_tokens: number
      tools?: unknown[]
    }
    if (
      wire.messages[0]?.role !== "system" ||
      wire.messages[1]?.content !== body.messages[0].content ||
      wire.tools?.length
    )
      throw new Error("Transport did not preserve the summary authority boundary")
    const id = `${row.id}-${call.index}`
    await Bun.write(path.join(output, `${id}-request.json`), JSON.stringify(wire, null, 2))
    cases.push({
      id,
      original,
      originalSHA256: createHash("sha256").update(bytes).digest("hex"),
      previousKnownTokens: call.usage?.total_tokens,
      roles: wire.messages.map((message) => message.role),
      maxTokens: wire.max_tokens,
    })
  }
}
await Bun.write(
  path.join(output, "prepared.json"),
  JSON.stringify(
    {
      sourceEvidence: root,
      sourceSHA256: createHash("sha256")
        .update(await Bun.file(new URL("../src/session/compaction.ts", import.meta.url)).text())
        .digest("hex"),
      networkRequests: 0,
      paidTokens: 0,
      cases,
    },
    null,
    2,
  ),
)
console.log(JSON.stringify({ output, networkRequests: 0, paidTokens: 0, cases }, null, 2))
