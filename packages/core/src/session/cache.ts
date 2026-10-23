export * as SessionCache from "./cache"

import { createHash } from "node:crypto"
import { Effect, Option, Schema, Stream } from "effect"
import { and, desc, eq, sql } from "drizzle-orm"
import type { LLMEvent, LLMRequest, Usage } from "@zaovra-ai/llm"
import { ToolDefinition } from "@zaovra-ai/llm"
import { RequestExecutor } from "@zaovra-ai/llm/route"
import { SessionUsage } from "@zaovra-ai/schema/session-usage"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { SessionProgress } from "./progress"

export const Snapshot = Schema.Struct({
  purpose: Schema.optional(Schema.Literals(["execution", "summary"])),
  durableMessages: Schema.optional(Schema.Number),
  tailMessages: Schema.optional(Schema.Number),
  systemSegments: Schema.optional(
    Schema.Array(Schema.Struct({ index: Schema.Number, hash: Schema.String, bytes: Schema.Number })),
  ),
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
export function snapshot(
  request: LLMRequest,
  epoch: number,
  boundary: { purpose?: "execution" | "summary"; durableMessages?: number } = {},
): typeof Snapshot.Type {
  return {
    model: `${request.model.provider}/${request.model.id}/${request.model.route.id}`,
    epoch,
    purpose: boundary.purpose ?? "execution",
    ...(boundary.durableMessages === undefined
      ? {}
      : {
          durableMessages: boundary.durableMessages,
          tailMessages: request.messages.length - boundary.durableMessages,
        }),
    systemSegments: request.system.map((part, index) => ({
      index,
      hash: createHash("sha256").update(JSON.stringify(part)).digest("hex"),
      bytes: Buffer.byteLength(JSON.stringify(part)),
    })),
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
  if ((previous.purpose ?? "execution") !== (current.purpose ?? "execution"))
    return { reason: "purpose", firstChanged: "purpose", commonSegments: 0 }
  if (previous.model !== current.model) return { reason: "model", firstChanged: "model", commonSegments: 0 }
  if (previous.epoch !== current.epoch) return { reason: "compaction", firstChanged: "epoch", commonSegments: 0 }
  const index = previous.segments.findIndex((segment, index) => segment.hash !== current.segments[index]?.hash)
  if (index < 0) return { reason: "append", firstChanged: null, commonSegments: previous.segments.length }
  const name = previous.segments[index]!.name
  return {
    reason: name.startsWith("message:")
      ? current.durableMessages === undefined
        ? "history-or-tail"
        : Number(name.slice(8)) < Math.min(previous.durableMessages ?? current.durableMessages, current.durableMessages)
          ? "durable"
          : "tail"
      : name,
    firstChanged: name,
    commonSegments: index,
  }
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
    if (details.phase === "attempt") {
      const attempt =
        "attempt" in details
          ? Option.getOrUndefined(Schema.decodeUnknownOption(SessionUsage.CacheAttempt)(details.attempt))
          : undefined
      if (previous && attempt)
        requests.set(details.requestID, {
          ...previous,
          attempts: [
            ...(previous.attempts ?? []).filter((item) => item.id !== attempt.id),
            { ...previous.attempts?.find((item) => item.id === attempt.id), ...attempt },
          ],
        })
      continue
    }
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
  const versions = new Map<string, NonNullable<SessionUsage.CacheReport["versions"]>[number]>()
  for (const point of points) {
    const responseModel = point.responseModel ?? null
    const systemFingerprint = point.systemFingerprint ?? null
    const key = JSON.stringify([responseModel, systemFingerprint])
    const previous = versions.get(key)
    versions.set(key, {
      responseModel,
      systemFingerprint,
      calls: (previous?.calls ?? 0) + 1,
      input: (previous?.input ?? 0) + (point.input ?? 0),
      output: (previous?.output ?? 0) + (point.output ?? 0),
      total: (previous?.total ?? 0) + (point.total ?? 0),
      unreported: (previous?.unreported ?? 0) + Number(point.total === null),
    })
  }
  const counts = new Map<string, number>()
  for (const point of points)
    if (point.reason !== "first" && point.reason !== "append")
      counts.set(point.reason, (counts.get(point.reason) ?? 0) + 1)
  return {
    points,
    versions: [...versions.values()],
    breaks: [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  }
}

export function track<E, R>(
  stream: Stream.Stream<LLMEvent, E, R>,
  input: {
    request: LLMRequest
    epoch: number
    purpose?: "execution" | "summary"
    durableMessages?: number
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
            sql`coalesce(json_extract(${EventTable.data}, '$.details.purpose'), 'execution') = ${input.purpose ?? "execution"}`,
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
      const current = snapshot(input.request, input.epoch, input)
      const requestID = SessionMessage.ID.create()
      yield* SessionProgress.record(input.events, input.sessionID, "cache", {
        phase: "request",
        requestID,
        snapshot: current,
        purpose: current.purpose!,
        ...compare(prior, current),
      })
      let reported: Usage | undefined
      let responseModel: string | null = null
      let systemFingerprint: string | null = null
      return stream.pipe(
        Stream.provideService(RequestExecutor.AttemptObserver, (attempt) =>
          SessionProgress.record(input.events, input.sessionID, "cache", { phase: "attempt", requestID, attempt }),
        ),
        Stream.tap((event) =>
          Effect.sync(() => {
            if ("usage" in event && event.usage) reported = event.usage
            if ("providerMetadata" in event) {
              const metadata =
                event.providerMetadata?.openai ?? event.providerMetadata?.anthropic ?? event.providerMetadata?.google
              if (metadata && typeof metadata === "object") {
                if ("model" in metadata && typeof metadata.model === "string") responseModel = metadata.model
                if ("system_fingerprint" in metadata && typeof metadata.system_fingerprint === "string")
                  systemFingerprint = metadata.system_fingerprint
              }
            }
          }),
        ),
        Stream.ensuring(
          Effect.suspend(() =>
            SessionProgress.record(input.events, input.sessionID, "cache", {
              phase: "usage",
              requestID,
              ...usage(reported),
              responseModel,
              systemFingerprint,
            }),
          ),
        ),
      )
    }),
  )
}
