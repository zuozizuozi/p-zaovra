// Offline request preparation only: no credentials, HTTP execution or model calls.
import { Effect, Exit, Cause } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM } from "../src"
import { LLMClient } from "../src/route"
import { OpenAICompatibleChat } from "../src/protocols/openai-compatible-chat"
import type { HttpPrepared } from "../src/route/transport/http"

const model = OpenAICompatibleChat.route
  .with({
    endpoint: { baseURL: "https://offline.invalid/v1" },
    limits: { context: 128000, output: 16384 },
  })
  .model({ id: "offline-custom-model", provider: "offline" })

const cases = [
  { name: "default", input: {} },
  { name: "typed-low", input: { providerOptions: { openai: { reasoningEffort: "low" } } } },
  { name: "typed-high", input: { providerOptions: { openai: { reasoningEffort: "high" } } } },
  { name: "typed-max", input: { providerOptions: { openai: { reasoningEffort: "max" } } } },
  { name: "variant-body-max", input: { http: { body: { reasoning_effort: "max" } } } },
  { name: "variant-body-thinking", input: { http: { body: { thinking: { type: "disabled" } } } } },
  { name: "output-32k-with-16k-metadata", input: { generation: { maxTokens: 32768 } } },
]

const rows = []
for (const entry of cases) {
  const request = LLM.request({ model, prompt: "Identical prompt for every case.", ...entry.input })
  const result = await Effect.runPromise(LLMClient.prepare<Record<string, unknown>>(request).pipe(Effect.exit))
  if (Exit.isFailure(result)) {
    rows.push({ case: entry.name, status: "rejected-locally", error: Cause.pretty(result.cause).split("\n")[0] })
    continue
  }
  // Materialize the final HTTP body, including variant overlays; never send it.
  const prepared = (await Effect.runPromise(
    model.route.prepareTransport(result.value.body, request),
  )) as HttpPrepared<unknown>
  const web = await Effect.runPromise(HttpClientRequest.toWeb(prepared.request))
  const wire = await web.json()
  rows.push({
    case: entry.name,
    status: "prepared",
    reasoning_effort: wire.reasoning_effort ?? null,
    thinking: wire.thinking ?? null,
    max_tokens: wire.max_tokens ?? null,
    messages: wire.messages,
  })
}
console.log(JSON.stringify({ networkRequests: 0, paidTokens: 0, rows }, null, 2))
