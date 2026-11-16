import { serialize, deserialize } from "node:v8"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { Model } from "../../../packages/schema/src/model"
import { createEvaluationMemoryProfile } from "./model-profile"
import { evaluationRelayBinding } from "./relay"

/** Private parent-host authority, retained across backend restarts. Never exposed in config.
 * The first projection is read by our owned backend before any model admission in the
 * fresh, host-written profile. Later backends must match that same private snapshot.
 */
export function createMemoryAuthority(input: {
  relay: object
  baseURL: string
  relayKey: string
  modelID: string
  providerID: string
  protocol: "openai-chat" | "openai-responses"
}) {
  const binding = evaluationRelayBinding(input.relay)
  if (
    binding.baseURL !== input.baseURL ||
    binding.apiKey !== input.relayKey ||
    binding.model !== input.modelID ||
    binding.protocol !== input.protocol
  )
    throw new Error("evaluation-memory-relay-mismatch")
  let revoked = false
  let frozen: Model.Info | undefined
  let grant: ReturnType<typeof createEvaluationMemoryProfile> | undefined
  return {
    endpointHash: binding.endpointHash,
    openStage(generation: string, directory: string) {
      if (revoked) throw new Error("evaluation-memory-authority-revoked")
      evaluationRelayBinding(input.relay)
      const key = randomUUID()
      let used = false
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        maxRequestBodySize: 65536,
        async fetch(request) {
          if (
            used ||
            request.method !== "POST" ||
            new URL(request.url).pathname !== "/profile" ||
            request.headers.get("authorization") !== `Bearer ${key}`
          )
            return new Response(null, { status: 403 })
          used = true
          try {
            if (revoked) throw new Error("evaluation-memory-authority-revoked")
            evaluationRelayBinding(input.relay)
            const body = (await request.json()) as { generation?: unknown; snapshot?: unknown }
            if (body.generation !== generation) throw new Error("generation")
            if (typeof body.snapshot !== "string" || body.snapshot.length > 60000) throw new Error("snapshot")
            const model: unknown = deserialize(Buffer.from(body.snapshot, "base64"))
            if (!Schema.is(Model.Info)(model)) throw new Error("model")
            if (
              model.providerID !== input.providerID ||
              model.id !== input.modelID ||
              model.api.url !== binding.baseURL ||
              (model.api.settings?.apiKey ?? model.request.body.apiKey) !== binding.apiKey ||
              model.request.variant !== undefined ||
              model.request.body.maxTokens !== 4096 ||
              model.limit.context !== 32000 ||
              model.limit.output !== 4096
            )
              throw new Error("projection")
            if (!frozen) {
              grant = createEvaluationMemoryProfile({
                model,
                variant: undefined,
                binding: { baseURL: binding.baseURL, modelID: binding.model, protocol: input.protocol },
              })
              frozen = structuredClone(model)
            }
            if (grant?.profile.memoryNote(model, undefined) !== true) throw new Error("changed")
            return Response.json(
              {
                snapshot: serialize(frozen).toString("base64"),
                binding: { baseURL: binding.baseURL, modelID: binding.model, protocol: input.protocol },
              },
              { headers: { "cache-control": "no-store" } },
            )
          } catch {
            return new Response(null, { status: 403 })
          }
        },
      })
      return {
        environment: JSON.stringify({
          url: new URL("profile", server.url).href,
          key,
          generation,
          directory,
          model: { id: input.modelID, providerID: input.providerID },
        }),
        async [Symbol.asyncDispose]() {
          used = true
          await server.stop(true)
        },
      }
    },
    revoke() {
      revoked = true
      grant?.revoke()
    },
  }
}
