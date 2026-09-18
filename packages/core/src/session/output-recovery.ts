export * as SessionOutputRecovery from "./output-recovery"

import { Effect, Schema } from "effect"
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm"
import type { Database } from "../database/database"
import { EventTable } from "../event/sql"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessageTable } from "./sql"
import type { SessionSchema } from "./schema"
import type { LLMRequest, Model } from "@zaovra-ai/llm"
import { Token } from "../util/token"
import { createHash } from "node:crypto"

export type Policy = { readonly initial: number; readonly maximum: number }
export type Category = "reasoning-exhaustion" | "tool-truncation" | "empty-output"
const retriedType = EventV2.versionedType(SessionEvent.Retried.type, SessionEvent.Retried.durable?.version ?? 1)
const endedType = EventV2.versionedType(SessionEvent.Step.Ended.type, SessionEvent.Step.Ended.durable?.version ?? 1)

/** Do not carry a pending adjustment to another gateway or model configuration. */
export const identity = (model: Model) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        provider: model.provider,
        model: model.id,
        route: model.route.id,
        endpoint: model.route.endpoint,
        defaults: model.defaults,
        routeDefaults: model.route.defaults,
      }),
    )
    .digest("hex")

/** Scope attempts to durable task progress, not drains or compacted history. */
export const read = (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const input = yield* db
      .select({ seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
      .orderBy(desc(SessionMessageTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    const rows = yield* db
      .select({ type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .where(
        and(
          eq(EventTable.aggregate_id, sessionID),
          gt(EventTable.seq, input?.seq ?? 0),
          inArray(EventTable.type, [retriedType, endedType]),
        ),
      )
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    const attempts = new Map<string, number>()
    let pending: Record<string, string> | undefined
    for (const row of rows) {
      if (row.type === endedType) {
        const step = Schema.decodeUnknownSync(SessionEvent.Step.Ended.data)(row.data)
        pending = undefined
        // A changed snapshot/file list is host evidence. Mere text, reads and
        // successful process exit codes must not renew the recovery allowance.
        if (step.files?.length) attempts.clear()
        continue
      }
      const retry = Schema.decodeUnknownSync(SessionEvent.Retried.data)(row.data)
      const metadata = retry.error.metadata
      if (!metadata || !["reasoning-exhaustion", "tool-truncation", "empty-output"].includes(metadata.phase)) continue
      attempts.set(metadata.phase, (attempts.get(metadata.phase) ?? 0) + 1)
      pending = metadata
    }
    return { attempts, pending }
  })

const positive = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

/** Metadata describes capacity; explicit generation settings are user ceilings. */
export function limits(model: Model, policy?: Policy) {
  const configured = positive(model.defaults?.generation?.maxTokens ?? model.route.defaults.generation?.maxTokens)
  const capability = positive(model.defaults?.limits?.output ?? model.route.defaults.limits?.output)
  const context = positive(model.defaults?.limits?.context ?? model.route.defaults.limits?.context)
  const maximum = Math.min(
    ...[configured, capability, policy?.maximum].filter((value): value is number => value !== undefined),
  )
  return {
    configured,
    context,
    maximum: Number.isFinite(maximum) ? maximum : undefined,
    initial: policy ? Math.min(policy.initial, maximum) : configured,
  }
}

export function budget(request: LLMRequest, policy: Policy | undefined, suggested?: number) {
  const available = limits(request.model, policy)
  const desired = positive(suggested) ?? available.initial
  if (desired === undefined) return undefined
  const room =
    available.context === undefined
      ? undefined
      : Math.max(
          0,
          available.context -
            Token.estimate(
              JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools }),
            ) -
            4096,
        )
  // A low estimate must never silently shrink an explicit request. Leave it to
  // the existing context-overflow path; only additional recovery space is clamped.
  if (suggested === undefined) return desired
  const expanded = Math.min(desired, available.maximum ?? desired, room ?? desired)
  return expanded > 0 ? expanded : available.initial
}

export function plan(input: {
  request: LLMRequest
  policy?: Policy
  attempts: number
  outputTokens: number
  inputTokens: number
}) {
  if (input.attempts >= 2) return undefined
  const available = limits(input.request.model, input.policy)
  const current = positive(input.request.generation?.maxTokens) ?? available.initial ?? positive(input.outputTokens)
  const desired =
    current === undefined || available.maximum === undefined || available.context === undefined
      ? undefined
      : budget(
          input.request,
          input.policy,
          Math.min(
            current * 2,
            available.maximum,
            Math.max(0, available.context - input.inputTokens - input.outputTokens - 4096),
          ),
        )
  if (desired !== undefined && current !== undefined && desired > current)
    return { strategy: "increase-output", maxTokens: desired }
  // One smaller-step attempt when capability is unknown or a hard limit prevents
  // expansion. Repeating the same fallback offers no new condition to test.
  if (input.attempts > 0) return undefined
  return {
    strategy: "smaller-step",
    maxTokens: current === undefined ? undefined : (input.request.generation?.maxTokens ?? available.initial),
  }
}

export function instruction(metadata: Record<string, string>) {
  return `Output recovery (${metadata.phase}, ${metadata.strategy ?? "smaller-step"}): the previous provider turn was incomplete. Preserve the original task and constraints. Use a small concrete next action, not another long plan. Review retained tool results and current files before repeating any side effect; completed tools must not be replayed blindly. Truncated or rejected tool arguments were not executed: regenerate only the unfinished call with complete parameters, in smaller edits where useful. Do not claim unfinished work is complete.`
}
