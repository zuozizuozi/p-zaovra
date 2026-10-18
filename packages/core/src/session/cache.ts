export * as SessionCache from "./cache"

import { createHash } from "node:crypto"
import { Effect, Option, Schema, Stream } from "effect"
import { and, desc, eq, sql } from "drizzle-orm"
import type { LLMEvent, LLMRequest, Usage } from "@zaovra-ai/llm"
import { ToolDefinition } from "@zaovra-ai/llm"
import { SessionUsage } from "@zaovra-ai/schema/session-usage"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { SessionProgress } from "./progress"

export const Snapshot = Schema.Struct({
  model: Schema.String,
  epoch: Schema.Number,
  segments: Schema.Array(Schema.Struct({ name: Schema.String, hash: Schema.String, bytes: Schema.Number })),
})

export function tools(definitions: readonly ToolDefinition[]) {
  return definitions
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((tool) =>
      Schema.decodeUnknownSync(Schema.UnknownFromJsonString.pipe(Schema.decodeTo(ToolDefinition)))(
        JSON.stringify(tool, (_key, value: unknown) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
        ),
      ),
    )
}

// Hash only prompt structure; never retain prompts, credentials or reasoning text.
// These are client-side segments, not an estimate of a provider's tokenizer/cache.
export function snapshot(request: LLMRequest, epoch: number): typeof Snapshot.Type {
  return {
    model: `${request.model.provider}/${request.model.id}/${request.model.route.id}`,
    epoch,
    segments: [
      { name: "tools", value: request.tools },
      { name: "system", value: request.system },
      ...request.messages.map((message, index) => ({
        name: `message:${index}`,
        value: { role: message.role, content: message.content, native: message.native },
      })),
    ].map((segment) => {
      const bytes = JSON.stringify(segment.value)
      return {
        name: segment.name,
        hash: createHash("sha256").update(bytes).digest("hex"),
        bytes: Buffer.byteLength(bytes),
      }
    }),
  }
}

export function compare(previous: typeof Snapshot.Type | undefined, current: typeof Snapshot.Type) {
  if (!previous) return { reason: "first", firstChanged: null, commonSegments: 0 }
  if (previous.model !== current.model) return { reason: "model", firstChanged: "model", commonSegments: 0 }
  if (previous.epoch !== current.epoch) return { reason: "compaction", firstChanged: "epoch", commonSegments: 0 }
  const index = previous.segments.findIndex((segment, index) => segment.hash !== current.segments[index]?.hash)
  if (index < 0) return { reason: "append", firstChanged: null, commonSegments: previous.segments.length }
  const name = previous.segments[index]!.name
  return { reason: name.startsWith("message:") ? "history-or-tail" : name, firstChanged: name, commonSegments: index }
}

export function usage(value: Usage | undefined) {
  const known = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? value : null
  const input = known(value?.inputTokens)
  const output = known(value?.outputTokens)
  const hit = known(value?.cacheReadInputTokens)
  const reasoning = known(value?.reasoningTokens)
  return {
    input,
    output,
    hit,
    reasoning,
    miss: hit === null ? null : known(value?.nonCachedInputTokens),
    hitRate: input !== null && input > 0 && hit !== null ? hit / input : null,
    visible: output !== null && reasoning !== null ? Math.max(0, output - reasoning) : null,
    total: known(value?.totalTokens) ?? (input !== null && output !== null ? input + output : null),
  }
}

export function report(
  rows: ReadonlyArray<{ seq: number; data: Record<string, unknown> }>,
): SessionUsage.CacheReport | undefined {
  const requests = new Map<string, SessionUsage.CachePoint>()
  for (const row of rows.toSorted((a, b) => a.seq - b.seq)) {
    const details = row.data.details
    if (
      row.data.category !== "cache" ||
      !details ||
      typeof details !== "object" ||
      !("requestID" in details) ||
      typeof details.requestID !== "string" ||
      !("phase" in details)
    )
      continue
    const previous = requests.get(details.requestID)
    const point = Option.getOrUndefined(
      Schema.decodeUnknownOption(SessionUsage.CachePoint)(
        details.phase === "request"
          ? { ...usage(undefined), sequence: row.seq, ...details }
          : previous
            ? { ...previous, ...details }
            : undefined,
      ),
    )
    if (point) requests.set(point.requestID, point)
  }
  if (!requests.size) return
  const points = [...requests.values()]
  const counts = new Map<string, number>()
  for (const point of points)
    if (point.reason !== "first" && point.reason !== "append")
      counts.set(point.reason, (counts.get(point.reason) ?? 0) + 1)
  return { points, breaks: [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) }
}

export function track<E, R>(
  stream: Stream.Stream<LLMEvent, E, R>,
  input: {
    request: LLMRequest
    epoch: number
    sessionID: SessionSchema.ID
    db: Database.Interface["db"]
    events: EventV2.Interface
  },
) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const previous = yield* input.db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, input.sessionID),
            eq(EventTable.type, "session.next.quality.progress.1"),
            sql`json_extract(${EventTable.data}, '$.category') = 'cache'`,
            sql`json_extract(${EventTable.data}, '$.details.phase') = 'request'`,
          ),
        )
        .orderBy(desc(EventTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      const details = previous?.data.details
      const prior =
        details && typeof details === "object" && "snapshot" in details
          ? Option.getOrUndefined(Schema.decodeUnknownOption(Snapshot)(details.snapshot))
          : undefined
      const current = snapshot(input.request, input.epoch)
      const requestID = SessionMessage.ID.create()
      yield* SessionProgress.record(input.events, input.sessionID, "cache", {
        phase: "request",
        requestID,
        snapshot: current,
        ...compare(prior, current),
      })
      let reported: Usage | undefined
      return stream.pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if ("usage" in event && event.usage) reported = event.usage
          }),
        ),
        Stream.ensuring(
          Effect.suspend(() =>
            SessionProgress.record(input.events, input.sessionID, "cache", {
              phase: "usage",
              requestID,
              ...usage(reported),
            }),
          ),
        ),
      )
    }),
  )
}
