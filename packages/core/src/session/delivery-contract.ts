export * as DeliveryContract from "./delivery-contract"

import { Schema, Option } from "effect"
import { Model } from "@zaovra-ai/schema/model"
import { Token } from "../util/token"
import { SessionUsageQuery } from "./usage"
import { DeliveryAudit } from "./delivery-audit"
import type { SessionMessage } from "./message"
import type { SessionOutcome } from "@zaovra-ai/schema/session-outcome"

/** One repair cycle, independent of strict verification and ordinary execution. */
export const budget = { turns: 3, output: 1_024, durationMs: 180_000, tools: 12, ratio: 0.15 } as const
export const prefix = "Delivery contract review: "
export const Receipt = Schema.Struct({
  request: Schema.String,
  started: Schema.Number,
  tokens: Schema.Number,
  decision: Schema.Literals(["review", "repair", "consumed", "finished", "unverified"]),
  missing: Schema.Array(Schema.String),
  reason: Schema.optional(Schema.String),
  turns: Schema.optional(Schema.Number),
  toolCalls: Schema.optional(Schema.Number),
  report: Schema.optional(Schema.Boolean),
  // Freeze the original allowance. Repair consumption earns no new credit.
  allowance: Schema.optional(Schema.Number),
  spent: Schema.optional(Schema.Number),
  cacheRead: Schema.optional(Schema.Number),
  estimatedCost: Schema.optional(Schema.Number),
  model: Schema.optional(Schema.String),
  costs: Schema.optional(Schema.Array(Model.Cost)),
  limits: Schema.optional(
    Schema.Struct({
      turns: Schema.Number,
      totalTokens: Schema.Number,
      outputTokens: Schema.Number,
      durationMs: Schema.Number,
      toolChecks: Schema.Number,
    }),
  ),
})

export function receipt(messages: readonly SessionMessage.Message[], request: string | undefined) {
  return messages
    .flatMap((message) => {
      if (message.type !== "synthetic" || !message.text.startsWith(prefix)) return []
      const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(Receipt)))(
        message.text.slice(prefix.length),
      )
      return Option.isSome(decoded) && decoded.value.request === request ? [{ ...decoded.value, id: message.id }] : []
    })
    .at(-1)
}

export function allowance(available: number, costs: readonly Model.Cost[], cacheRead: number, request: unknown) {
  const input = Token.estimate(JSON.stringify(request)) + 512
  const cached = Math.max(0, Math.min(cacheRead, input))
  const tokens = (output: number) => ({
    input: input - cached,
    output,
    reasoning: 0,
    cacheRead: cached,
    cacheWrite: 0,
    total: input + output,
    calls: 1,
    unreported: 0,
  })
  const base = SessionUsageQuery.estimateRequest(tokens(0), costs).amount
  const full = SessionUsageQuery.estimateRequest(tokens(budget.output), costs).amount
  if (base === null || full === null || base > available)
    return { output: 0, estimatedCost: base ?? 0, input, cacheRead: cached }
  const rate = (full - base) / budget.output
  const output = Math.max(0, Math.min(budget.output, rate > 0 ? Math.floor((available - base) / rate) : budget.output))
  return { output, estimatedCost: base + rate * output, input, cacheRead: cached }
}

/** Unknown coverage alone never launches extra model work. */
export function gaps(
  entries: Parameters<typeof DeliveryAudit.expected>[0],
  artifacts: readonly DeliveryAudit.Observation[],
  checks: readonly SessionOutcome.Check[],
) {
  return [
    ...artifacts
      .filter(
        (item) =>
          item.problem && !item.problem.startsWith("unverified:") && !item.problem.startsWith("outside workspace"),
      )
      .map((item) => `requirement ${item.requirement} (${item.path}): ${item.problem}`),
    ...entries
      .filter(
        (entry) =>
          !entry.withdrawnBy &&
          !entry.data &&
          /^(?:(?:请)?实际(?:运行|执行)|(?:please\s+)?actually\s+(?:run|execute))/iu.test(entry.text.trim()),
      )
      .filter(
        (entry) =>
          !checks.some(
            (check) =>
              check.exit === 0 &&
              !check.execution &&
              !check.supersededBy &&
              ["smoke", "interaction"].includes(check.kind) &&
              check.requirements?.includes(entry.text),
          ),
      )
      .map((entry) => `requirement ${entry.id}: actual execution evidence missing: ${entry.text}`),
    ...checks
      .filter((check) => check.exit !== 0 && !check.supersededBy && !check.execution)
      .map((check) => `failed: ${check.kind} (${check.callID})`),
  ]
}

export const repairTools = new Set([
  "read",
  "write",
  "edit",
  "apply_patch",
  "bash",
  "bash_job",
  "glob",
  "grep",
  "list",
  "ls",
  "evidence_read",
  "evidence_search",
  "publish_artifact",
])
