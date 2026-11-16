export * as MemoryReadSource from "./read-source"

import { createHash } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import type { Location } from "../location"
import { ReadReceiptTable } from "../read-receipt.sql"
import { SessionEvent } from "../session/event"
import type { SessionSchema } from "../session/schema"
import { SessionMessageTable, SessionTable } from "../session/sql"
import { MemoryFileEvidence } from "./file-evidence"

export const Selection = Schema.Struct({
  callID: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
}).annotate({
  description:
    "An earlier complete Read in this session: its tool call ID and canonical project-relative path. This is historical evidence, not a current file check.",
})
export type Selection = typeof Selection.Type

const local = Schema.is(Schema.Struct({ executed: Schema.Literal(false) }))

/** Read only durable host evidence. Never resolve, stat or reopen a selected path. */
export const resolve = Effect.fn("MemoryReadSource.resolve")(function* (
  database: Database.Interface,
  location: Location.Interface,
  source: { sessionID: SessionSchema.ID; seq: number },
  selection: Selection,
) {
  const db = database.db
  const matches = yield* db
    .select()
    .from(ReadReceiptTable)
    .where(
      and(
        eq(ReadReceiptTable.session_id, source.sessionID),
        eq(ReadReceiptTable.call_id, selection.callID),
        eq(ReadReceiptTable.resource, selection.path),
      ),
    )
    .limit(2)
    .all()
    .pipe(Effect.orDie)
  // Providers can reuse call IDs across turns. Ambiguity is not permission to
  // choose the latest receipt or another Assistant silently.
  if (matches.length !== 1) return
  const receipt = matches[0]!
  if (
    receipt.directory !== location.directory ||
    receipt.project_id !== location.project.id ||
    (receipt.workspace_id ?? undefined) !== location.workspaceID ||
    !path.isAbsolute(receipt.path) ||
    !Number.isSafeInteger(receipt.called_seq) ||
    receipt.called_seq <= 0 ||
    !Number.isSafeInteger(receipt.success_seq) ||
    receipt.success_seq <= receipt.called_seq ||
    receipt.success_seq >= source.seq ||
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes < 0 ||
    receipt.bytes > 51200 ||
    !/^\d+$/.test(receipt.volume_id) ||
    !/^[a-f0-9]{32}$/.test(receipt.file_id)
  )
    return
  const session = yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, source.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (
    !session ||
    session.parent_id ||
    session.directory !== location.directory ||
    session.project_id !== location.project.id ||
    (session.workspace_id ?? undefined) !== location.workspaceID
  )
    return
  const author = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(
      and(
        sql`${SessionMessageTable.id} = ${receipt.assistant_message_id}`,
        eq(SessionMessageTable.session_id, source.sessionID),
        eq(SessionMessageTable.type, "assistant"),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!author) return
  const events = yield* db
    .select()
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, source.sessionID),
        inArray(EventTable.seq, [receipt.called_seq, receipt.success_seq]),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const called = events.find((event) => event.seq === receipt.called_seq)
  const success = events.find((event) => event.seq === receipt.success_seq)
  if (
    !called ||
    !success ||
    called.type !==
      EventV2.versionedType(SessionEvent.Tool.Called.type, SessionEvent.Tool.Called.durable?.version ?? 1) ||
    success.type !==
      EventV2.versionedType(SessionEvent.Tool.Success.type, SessionEvent.Tool.Success.durable?.version ?? 1) ||
    called.data.tool !== "read" ||
    !local(called.data.provider) ||
    !local(success.data.provider) ||
    (Array.isArray(success.data.outputPaths) && success.data.outputPaths.length > 0) ||
    [called, success].some(
      (event) =>
        event.data.sessionID !== source.sessionID ||
        event.data.assistantMessageID !== receipt.assistant_message_id ||
        event.data.callID !== selection.callID,
    )
  )
    return
  const output = success.data.structured
  if (
    !output ||
    typeof output !== "object" ||
    !("encoding" in output) ||
    output.encoding !== "utf8" ||
    !("content" in output) ||
    typeof output.content !== "string" ||
    !("uri" in output) ||
    output.uri !== pathToFileURL(receipt.path).href ||
    Buffer.byteLength(output.content) > 51200
  )
    return
  const bytes = Buffer.from(output.content, "utf8")
  // TextDecoder removes one leading UTF-8 BOM. The receipt hashes the raw
  // stream, while the durable success stores its decoded text.
  const raw =
    receipt.bytes === bytes.length
      ? bytes
      : receipt.bytes === bytes.length + 3
        ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])
        : undefined
  if (!raw || createHash("sha256").update(raw).digest("hex") !== receipt.digest) return
  // Read's producer emits a relative resource only for an internal selection.
  // The stored canonical path is historical: do not resolve today's aliases.
  return MemoryFileEvidence.bindings([
    {
      path: receipt.resource,
      directory: receipt.directory,
      identity: JSON.stringify(["windows-file-id", receipt.volume_id, receipt.file_id]),
      digest: receipt.digest,
      bytes: receipt.bytes,
      sessionID: source.sessionID,
      seq: receipt.success_seq,
    },
  ])?.files
})
