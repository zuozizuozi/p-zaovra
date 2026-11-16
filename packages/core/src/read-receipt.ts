export * as ReadReceipt from "./read-receipt"

import { randomUUID } from "node:crypto"
import { and, desc, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { ToolOutput } from "@zaovra-ai/llm"
import type { Database } from "./database/database"
import { EventTable } from "./event/sql"
import { SessionEvent } from "./session/event"
import { EventV2 } from "./event"
import { ReadReceiptTable } from "./read-receipt.sql"
import type { Tool } from "./tool/tool"
import { SessionTable, SessionMessageTable } from "./session/sql"

export interface Observation {
  readonly directory: string
  readonly projectID: string
  readonly workspaceID?: string
  readonly path: string
  readonly resource: string
  readonly digest: string
  readonly bytes: number
  readonly text: string
  readonly volume: string
  readonly file: string
  readonly written: string
  readonly changed: string
}
type Source = Pick<Tool.Context, "sessionID" | "assistantMessageID" | "toolCallID">
type Candidate = { source: Source; observation: Observation; database: Database.Interface }
const producers = new WeakSet<object>()
const active = new WeakMap<object, (value: Candidate) => void>()
const outputs = new WeakMap<object, Candidate>()

/** Internal builtin identity, never inferred from the public tool name. */
export function trusted<T extends object>(tool: T): T {
  producers.add(tool)
  return tool
}

export function capture(source: Tool.Context, tool: object) {
  let candidate: Candidate | undefined
  if (producers.has(tool))
    active.set(source, (value) => {
      candidate = value
    })
  return {
    close: () => {
      active.delete(source)
    },
    attach: (output: ToolOutput) => {
      const value = output.structured
      // Generic output bounding or encoding must not turn a partial result into
      // a complete-file observation. LLMEvent wraps ToolOutput again, but retains
      // this structured object's identity. Serialized/provider clones have none.
      if (
        candidate &&
        value &&
        typeof value === "object" &&
        "content" in value &&
        "encoding" in value &&
        value.encoding === "utf8" &&
        value.content === candidate.observation.text
      )
        outputs.set(value, candidate)
      candidate = undefined
    },
  }
}

export function stage(source: Tool.Context, observation: Observation, database: Database.Interface) {
  active.get(source)?.({ source, observation, database })
}

/** One-shot private token, not serialized as part of tool output or provider metadata. */
export function commit(output: ToolOutput | undefined, source: Source) {
  const value = output?.structured
  if (!value || typeof value !== "object") return
  const candidate = outputs.get(value)
  outputs.delete(value)
  if (
    !candidate ||
    source.sessionID !== candidate.source.sessionID ||
    source.assistantMessageID !== candidate.source.assistantMessageID ||
    source.toolCallID !== candidate.source.toolCallID ||
    !("encoding" in value) ||
    value.encoding !== "utf8" ||
    !("content" in value) ||
    value.content !== candidate.observation.text
  )
    return
  return (seq: number) =>
    Effect.gen(function* () {
      const db = candidate.database.db
      const observation = candidate.observation
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, source.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (
        !session ||
        session.directory !== observation.directory ||
        session.project_id !== observation.projectID ||
        (session.workspace_id ?? undefined) !== observation.workspaceID
      )
        return
      const author = yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, source.sessionID),
            eq(SessionMessageTable.id, source.assistantMessageID),
            eq(SessionMessageTable.type, "assistant"),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!author) return
      const called = yield* db
        .select()
        .from(EventTable)
        .where(
          and(
            eq(EventTable.aggregate_id, source.sessionID),
            eq(
              EventTable.type,
              EventV2.versionedType(SessionEvent.Tool.Called.type, SessionEvent.Tool.Called.durable?.version ?? 1),
            ),
            sql`json_extract(${EventTable.data}, '$.assistantMessageID') = ${source.assistantMessageID}`,
            sql`json_extract(${EventTable.data}, '$.callID') = ${source.toolCallID}`,
          ),
        )
        .orderBy(desc(EventTable.seq))
        .get()
        .pipe(Effect.orDie)
      if (
        !called ||
        called.seq >= seq ||
        called.data.tool !== "read" ||
        !called.data.provider ||
        typeof called.data.provider !== "object" ||
        !("executed" in called.data.provider) ||
        called.data.provider.executed !== false
      )
        return
      yield* db
        .insert(ReadReceiptTable)
        .values({
          id: randomUUID(),
          session_id: source.sessionID,
          assistant_message_id: source.assistantMessageID,
          call_id: source.toolCallID,
          called_seq: called.seq,
          success_seq: seq,
          directory: observation.directory,
          path: observation.path,
          resource: observation.resource,
          project_id: observation.projectID,
          workspace_id: observation.workspaceID,
          digest: observation.digest,
          bytes: observation.bytes,
          volume_id: observation.volume,
          file_id: observation.file,
          written: observation.written,
          changed: observation.changed,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })
}
