import { isDeepStrictEqual } from "node:util"
import type { ModelV2 } from "../../../packages/core/src/model"
import type { ModelMemoryProfile } from "../../../packages/core/src/model-memory-profile"

/** Experimental C-treatment permission, never a production reliability result.
 * The host supplies an independently frozen Catalog projection and owns the live
 * relay and isolated credentials. This comparison cannot observe credential
 * metadata merged later by the resolver or attest the final upstream request.
 * No model/config/key snapshot is exposed in the return value or diagnostics.
 */
export function createEvaluationMemoryProfile(input: {
  model: ModelV2.Info
  variant: string | undefined
  binding: { baseURL: string; modelID: string; protocol: "openai-chat" | "openai-responses" }
}) {
  const endpoint = URL.canParse(input.binding.baseURL) ? new URL(input.binding.baseURL) : undefined
  if (
    !endpoint ||
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.pathname !== "/v1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !input.model.enabled ||
    !input.model.capabilities.tools ||
    input.model.memoryNote === "off" ||
    input.model.api.type !== "aisdk" ||
    input.model.api.url !== input.binding.baseURL ||
    input.model.api.id !== input.binding.modelID ||
    !["openai-chat", "openai-responses"].includes(input.binding.protocol) ||
    input.model.api.package !==
      (input.binding.protocol === "openai-responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible") ||
    new Set(input.model.variants.map((variant) => variant.id)).size !== input.model.variants.length ||
    (input.variant === undefined && input.model.request.variant !== undefined) ||
    (input.variant !== undefined && !input.model.variants.some((variant) => variant.id === input.variant))
  )
    throw new Error("invalid-evaluation-memory-profile")
  const expected = snapshot(input.model, input.variant)
  let revoked = false
  const profile: ModelMemoryProfile.Interface = {
    memoryNote: (model, variant) =>
      !revoked && isDeepStrictEqual({ model: projection(model), variant }, expected) ? true : undefined,
  }
  return {
    profile,
    revoke() {
      revoked = true
    },
  }
}

function snapshot(model: ModelV2.Info, variant: string | undefined) {
  try {
    return structuredClone({ model: projection(model), variant })
  } catch {
    // Unsupported plugin settings must not leak their value through clone errors.
    throw new Error("invalid-evaluation-memory-profile")
  }
}

function projection(model: ModelV2.Info) {
  return {
    id: model.id,
    providerID: model.providerID,
    api: model.api,
    request: model.request,
    // Freeze all variants, including the configured default, so later switching
    // or editing a named variant cannot inherit this experimental permission.
    variants: model.variants,
    limit: model.limit,
    enabled: model.enabled,
    memoryNote: model.memoryNote,
    // Catalog itself derives this one flag by calling the profile. Including it
    // would make the leaf reject the same projection after advertisement.
    capabilities: Object.fromEntries(Object.entries(model.capabilities).filter(([key]) => key !== "memoryNote")),
  }
}
