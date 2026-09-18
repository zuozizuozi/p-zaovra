export * as SessionUsageQuery from "./usage"

import { Effect, Schema } from "effect"
import { and, eq, inArray, sql } from "drizzle-orm"
import { SessionUsage } from "@zaovra-ai/schema/session-usage"
import { SessionEvent } from "@zaovra-ai/schema/session-event"
import { Event } from "@zaovra-ai/schema/event"
import { Database } from "../database/database"
import { EventTable } from "../event/sql"

const definitions = [
  SessionEvent.Step.Started,
  SessionEvent.Step.Ended,
  SessionEvent.Step.Failed,
  SessionEvent.Compaction.Ended,
  SessionEvent.Compaction.Failed,
  SessionEvent.Prompted,
]
const types = definitions.map((item) => Event.versionedType(item.type, item.durable?.version ?? 1))

export const read = Effect.fn("SessionUsage.read")(function* (sessionID?: string) {
  const database = yield* Database.Service
  // Read settlements, not projected messages: copied fork history is not another request,
  // and reverting or deleting a conversation must not refund its recorded usage.
  const rows = yield* database.db
    .select({
      aggregate_id: EventTable.aggregate_id,
      seq: EventTable.seq,
      type: EventTable.type,
      // Never load prompts, attachments or summary text just to count usage.
      data: sql`json_remove(${EventTable.data}, '$.prompt', '$.text', '$.recent')`.mapWith(EventTable.data),
    })
    .from(EventTable)
    .where(and(inArray(EventTable.type, types), sessionID ? eq(EventTable.aggregate_id, sessionID) : undefined))
    .all()
    .pipe(Effect.orDie)
  const summary = summarize(rows)
  return { ...summary, lastTurn: sessionID ? summary.lastTurn : null }
})

type MutableTotals = { -readonly [Key in keyof SessionUsage.Totals]: SessionUsage.Totals[Key] }
const empty = (): MutableTotals => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  calls: 0,
  unreported: 0,
})

export function summarize(
  rows: ReadonlyArray<{ aggregate_id: string; seq: number; type: string; data: Record<string, unknown> }>,
): SessionUsage.Summary {
  const starts = new Map<string, typeof SessionEvent.Step.Started.data.Type>()
  const prompts = new Map<string, number>()
  const callRounds = new Map<string, string>()
  const settlements = new Map<string, { session: string; seq: number; tokens: SessionUsage.Totals }>()
  rows
    .toSorted((a, b) => a.seq - b.seq)
    .forEach((row) => {
      if (row.type === types[5]) {
        prompts.set(row.aggregate_id, row.seq)
        return
      }
      const key = `${row.aggregate_id}:${row.data.assistantMessageID}`
      if (row.type === types[0]) {
        starts.set(key, Schema.decodeUnknownSync(SessionEvent.Step.Started.data)(row.data))
        callRounds.set(key, `${row.aggregate_id}:${prompts.get(row.aggregate_id) ?? row.data.inputSequence ?? key}`)
        return
      }
      if (row.type === types[3] || row.type === types[4]) {
        if (prompts.has(row.aggregate_id))
          callRounds.set(
            `${row.aggregate_id}:compaction:${row.data.messageID}`,
            `${row.aggregate_id}:${prompts.get(row.aggregate_id)}`,
          )
        return
      }
      const previous = settlements.get(key)
      if (previous && previous.seq <= row.seq) return
      if (row.type === types[2]) {
        settlements.set(key, {
          session: row.aggregate_id,
          seq: row.seq,
          tokens: { ...empty(), calls: 1, unreported: 1 },
        })
        return
      }
      if (row.type !== types[1]) return
      const data = Schema.decodeUnknownSync(SessionEvent.Step.Ended.data)(row.data)
      if (data.requestPerformed === false) return
      const safe = (value: number) => Math.max(0, Number.isFinite(value) ? value : 0)
      const values = {
        input: safe(data.tokens.input),
        output: safe(data.tokens.output),
        reasoning: safe(data.tokens.reasoning),
        cacheRead: safe(data.tokens.cache.read),
        cacheWrite: safe(data.tokens.cache.write),
      }
      const total = Object.values(values).reduce((sum, value) => sum + value, 0)
      settlements.set(key, {
        session: row.aggregate_id,
        seq: row.seq,
        tokens: {
          ...values,
          total,
          calls: 1,
          unreported: data.usageReported === false || (data.usageReported === undefined && total === 0) ? 1 : 0,
        },
      })
    })
  // Compaction is a real provider request too, even though it has no assistant bubble.
  rows
    .filter((row) => row.type === types[3] || row.type === types[4])
    .forEach((row) => {
      const key = `${row.aggregate_id}:compaction:${row.data.messageID}`
      if (settlements.has(key)) return
      const data =
        row.type === types[3]
          ? Schema.decodeUnknownSync(SessionEvent.Compaction.Ended.data)({ ...row.data, text: "", recent: "" })
          : Schema.decodeUnknownSync(SessionEvent.Compaction.Failed.data)(row.data)
      const tokens = data.usage?.tokens
      const values = {
        input: Math.max(0, tokens?.input ?? 0),
        output: Math.max(0, tokens?.output ?? 0),
        reasoning: Math.max(0, tokens?.reasoning ?? 0),
        cacheRead: Math.max(0, tokens?.cache.read ?? 0),
        cacheWrite: Math.max(0, tokens?.cache.write ?? 0),
      }
      settlements.set(key, {
        session: row.aggregate_id,
        seq: row.seq,
        tokens: {
          ...values,
          total: Object.values(values).reduce((sum, value) => sum + value, 0),
          calls: 1,
          unreported: data.usage?.reported ? 0 : 1,
        },
      })
      const preceding = rows
        .filter((item) => item.aggregate_id === row.aggregate_id && item.type === types[0] && item.seq < row.seq)
        .sort((a, b) => b.seq - a.seq)[0]
      if (data.usage)
        starts.set(
          key,
          Schema.decodeUnknownSync(SessionEvent.Step.Started.data)({
            sessionID: row.aggregate_id,
            assistantMessageID: row.data.messageID,
            timestamp: row.data.timestamp,
            agent: "compaction",
            model: { id: "compaction", providerID: data.usage.providerID },
            ...(preceding?.data.inputSequence === undefined ? {} : { inputSequence: preceding.data.inputSequence }),
          }),
        )
    })
  const result = {
    total: empty(),
    own: empty(),
    official: empty(),
    unknown: empty(),
    updatedAt: Date.now(),
    billing: "unavailable" as const,
  }
  const rounds = new Map<string, { seq: number; tokens: MutableTotals }>()
  const add = (target: MutableTotals, value: SessionUsage.Totals) => {
    Object.keys(value).forEach((key) => {
      target[key as keyof SessionUsage.Totals] += value[key as keyof SessionUsage.Totals]
    })
  }
  settlements.forEach((settlement, key) => {
    const start = starts.get(key)
    const provider = start?.model.providerID
    const source = !provider ? "unknown" : provider === "zaovra" || provider.startsWith("zaovra-") ? "official" : "own"
    add(result.total, settlement.tokens)
    add(result[source], settlement.tokens)
    const roundKey = callRounds.get(key) ?? `${settlement.session}:${start?.inputSequence ?? key}`
    const round = rounds.get(roundKey) ?? { seq: settlement.seq, tokens: empty() }
    add(round.tokens, settlement.tokens)
    round.seq = Math.max(round.seq, settlement.seq)
    rounds.set(roundKey, round)
  })
  // inputSequence advances after tool calls. The promoted user prompt is the turn boundary.
  const latest = [...rounds.values()].sort((a, b) => b.seq - a.seq)[0]
  return { ...result, lastTurn: latest?.tokens ?? null }
}
