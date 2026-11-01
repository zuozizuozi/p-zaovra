export * as SessionContextWindow from "./context-window"

import type { LLMRequest, Usage } from "@zaovra-ai/llm"
import { createHash } from "node:crypto"
import { SessionCache } from "./cache"

type Segment = { readonly name: string; readonly hash: string; readonly bytes: number }
type Snapshot = { readonly key: string; readonly epoch: string; readonly segments: readonly Segment[] }

function snapshot(request: LLMRequest, epoch: number | string): Snapshot {
  const route = request.model.route
  const options = JSON.stringify({ providerOptions: request.providerOptions, toolChoice: request.toolChoice })
  return {
    key: createHash("sha256")
      .update(
        JSON.stringify({
          provider: request.model.provider,
          model: request.model.id,
          route: route.id,
          protocol: route.protocol,
          transport: route.transport.id,
          baseURL: route.endpoint.baseURL,
          path: String(route.endpoint.path),
          query: route.endpoint.query,
          limits: route.defaults.limits,
        }),
      )
      .digest("hex"),
    epoch: String(epoch),
    // Retain hashes and byte counts only, never prompts, media or authentication.
    segments: [
      ...SessionCache.snapshot(request, 0).segments,
      {
        name: "options",
        hash: createHash("sha256").update(options).digest("hex"),
        bytes: Buffer.byteLength(options),
      },
    ],
  }
}

// Unknown usage keeps a UTF-8 byte proxy; added content gets a wider margin.
// Neither value is a tokenizer result or a hard upper bound for every provider.
const estimateSegments = (segments: readonly Segment[], bytesPerToken = 2) =>
  segments.reduce((total, segment) => total + Math.ceil(segment.bytes / bytesPerToken) + 32, 0)

export const estimateInput = (request: LLMRequest) => 256 + estimateSegments(snapshot(request, 0).segments, 4)

export function make() {
  let serial = 0
  let active: Snapshot | undefined
  let reported: { readonly snapshot: Snapshot; readonly input: number } | undefined
  return {
    estimate(request: LLMRequest, epoch: number | string) {
      const current = snapshot(request, epoch)
      if (active && (active.key !== current.key || active.epoch !== current.epoch)) {
        serial++
        active = undefined
        reported = undefined
      }
      const previous = reported
      if (!previous) return { tokens: 256 + estimateSegments(current.segments, 4), source: "estimate" as const }
      const added = current.segments.filter(
        (segment) => previous.snapshot.segments.find((prior) => prior.name === segment.name)?.hash !== segment.hash,
      )
      return { tokens: previous.input + estimateSegments(added), source: "reported-plus-delta" as const }
    },
    start(request: LLMRequest, epoch: number | string) {
      const ticket = ++serial
      const current = snapshot(request, epoch)
      active = current
      reported = undefined
      let settled = false
      return (usage: Usage | undefined) => {
        if (settled || serial !== ticket) return
        settled = true
        const input = usage?.inputTokens
        if (
          input === undefined ||
          !Number.isFinite(input) ||
          input <= 0 ||
          (usage?.cacheReadInputTokens ?? 0) > input ||
          (usage?.cacheWriteInputTokens ?? 0) > input
        )
          return
        // Canonical inputTokens already includes cache reads/writes; never add them again.
        reported = { snapshot: current, input }
      }
    },
  }
}

export type State = ReturnType<typeof make>
