export * as MemoryStore from "./store"

import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Memory } from "@zaovra-ai/schema/memory"
import { Database } from "../database/database"
import { ProjectV2 } from "../project"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"
import { SessionMessage } from "../session/message"
import { SessionMessageTable, SessionTable } from "../session/sql"
import { Hash } from "../util/hash"
import { MemoryFileEvidence } from "./file-evidence"
import { MemoryNoteTable, MemoryRecoveryTable, MemoryRecoveryClaimTable } from "./sql"

export interface ObserveInput {
  readonly scope: Memory.Scope
  readonly kind: Memory.Kind
  /** Identity of the fact: the same key observed again strengthens the note instead of adding one. */
  readonly key: string
  readonly text: string
  readonly verification: string
  readonly sessionID: SessionSchema.ID
  readonly seq?: number
  /** A fact the user stated in their own words needs no second sighting. */
  readonly settled?: boolean
}

export interface WriteInput {
  readonly scope: Memory.Scope
  readonly kind: Memory.Kind
  readonly text: string
  readonly origin: Memory.Origin
  readonly status: Memory.Status
  readonly verification?: string
  readonly sessionID?: SessionSchema.ID
  readonly seq?: number
  /** Host-validated historical source. One extracted note per message, independent of model wording. */
  readonly extractedMessageID?: SessionMessage.ID
  /** Host-validated prior Read evidence, inserted atomically with a new model note. */
  readonly readFiles?: ReadonlyArray<Memory.FileBinding>
}

export interface EditInput {
  readonly text?: string
  readonly kind?: Memory.Kind
  readonly status?: Memory.Status
}

/** One outcome of going back over a note: it was checked, it no longer holds, or it repeats another. */
export interface Decision {
  readonly id: Memory.ID
  readonly action: "verify" | "stale" | "merge"
  /** For a merge: the note that stays. */
  readonly into?: Memory.ID
  /** For a merge: wording that covers both, replacing the text of the note that stays. */
  readonly text?: string
  /** What the decision rests on, in words a person can check. */
  readonly basis: string
}

/** Where a scope's own conversations are found. */
export interface Place {
  readonly project: ProjectV2.ID
  readonly directory: string
}

/**
 * Every folder that is not a repository shares one project ID, so such a folder is its own
 * scope; otherwise unrelated folders would read each other's notes.
 */
export function scope(place: Place, platform: NodeJS.Platform = process.platform) {
  if (place.project !== ProjectV2.ID.global) return Memory.Scope.make(place.project)
  // Location owns path identity. POSIX case and literal backslashes must survive; the new
  // namespace must not adopt a legacy bucket whose normalization may have mixed directories.
  if (platform !== "win32") return Memory.Scope.make(`dir_posix_v2_${Hash.fast(place.directory).slice(0, 24)}`)
  return Memory.Scope.make(`dir_${Hash.fast(place.directory.replaceAll("\\", "/").toLowerCase()).slice(0, 24)}`)
}

export interface SearchInput {
  readonly scope: Memory.Scope
  /** Whose earlier conversations to look through; without it only notes are searched. */
  readonly place?: Place
  readonly query: string
  /** The conversation doing the search; its own messages are not memory. */
  readonly exclude?: SessionSchema.ID
  readonly limit?: number
}

export interface Interface {
  /** Bind a Location directory before using its scope; no legacy content is read into context. */
  readonly scope: (place: Place) => Effect.Effect<Memory.Scope>
  /** Safe status for hosts, including old tidy-run lifecycle handling. */
  readonly recovery: (place: Place) => Effect.Effect<Memory.Recovery>
  readonly resolveRecovery: (place: Place, choice: Memory.RecoveryChoice) => Effect.Effect<boolean>
  /** Rechecked inside tidy admission/tool transactions; manual recovery never overrides this. */
  readonly canAutomate: (scope: Memory.Scope) => Effect.Effect<boolean>

  /** Notes of one scope, newest first. Deleted notes are never returned. */
  readonly list: (scope: Memory.Scope) => Effect.Effect<ReadonlyArray<Memory.Note>>
  readonly get: (id: Memory.ID) => Effect.Effect<Memory.Note | undefined>
  /** Records a fact the host saw for itself. A fact the user deleted stays deleted. */
  readonly observe: (input: ObserveInput) => Effect.Effect<Memory.Note | undefined>
  readonly write: (input: WriteInput) => Effect.Effect<Memory.Note | undefined>
  /** Internal host-only storage. No route/tool exposes these calls or grants read permission. */
  readonly bindFiles: (input: MemoryFileEvidence.Bind) => Effect.Effect<boolean>
  readonly checkFiles: (input: MemoryFileEvidence.Check) => Effect.Effect<boolean>
  readonly canCheckFiles: (scope: Memory.Scope) => Effect.Effect<boolean>
  /** Watcher hints only downgrade evidence; they do not read files or confirm deletion. */
  readonly invalidateFiles: (input: {
    readonly scope: Memory.Scope
    readonly directory: string
    readonly paths?: ReadonlyArray<string>
  }) => Effect.Effect<void>
  readonly edit: (id: Memory.ID, input: EditInput) => Effect.Effect<Memory.Note | undefined>
  readonly remove: (id: Memory.ID) => Effect.Effect<void>
  readonly clear: (scope: Memory.Scope) => Effect.Effect<void>
  /**
   * Applies the outcome of a review to the notes of one scope. What the user wrote is theirs:
   * a review never rewords it, retires it or folds it into another note.
   */
  readonly review: (
    scope: Memory.Scope,
    decisions: ReadonlyArray<Decision>,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: Memory.ID; readonly result: string }>>
  /** Turns recording for one scope off or back on; what is already kept stays. */
  readonly silence: (scope: Memory.Scope, silent: boolean) => Effect.Effect<void>
  readonly search: (input: SearchInput) => Effect.Effect<{
    readonly notes: ReadonlyArray<Memory.Note>
    readonly sessions: ReadonlyArray<Memory.SessionMatch>
  }>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/v2/MemoryStore") {}

/** The basis recorded for a note taken from the user's own words. */
export const said = "the user's own words"

/** Free-form model evidence is not provenance. Only a host quote or explicit user action owns a note. */
export function protectedByUser(note: { origin: Memory.Origin; verification?: string | null }) {
  return note.origin === "user" || (note.origin === "program" && note.verification === said)
}

export interface Term {
  readonly text: string
  /** A whole word says more than two adjacent characters of a language written without spaces. */
  readonly weight: number
}

/**
 * What a query is matched on: its words, and for text written without spaces every pair of
 * adjacent characters. People and models ask in sentences, so a match needs most of the query,
 * not all of it.
 */
export function terms(query: string): ReadonlyArray<Term> {
  const lower = query.toLowerCase()
  const words = (lower.match(/[a-z0-9_][a-z0-9_.\-/]+/g) ?? []).map((text) => ({ text, weight: 2 }))
  const pairs = (lower.match(/[\u3400-\u9fff]+/g) ?? []).flatMap((run) =>
    Array.from({ length: Math.max(0, run.length - 1) }, (_, index) => ({
      text: run.slice(index, index + 2),
      weight: 1,
    })),
  )
  return Array.from(new Map([...words, ...pairs].map((term) => [term.text, term])).values()).slice(0, 16)
}

/** How much of the query a text contains; zero unless it holds about half of it. */
export function relevance(text: string, words: ReadonlyArray<Term>) {
  const lower = text.toLowerCase()
  const total = words.reduce((sum, word) => sum + word.weight, 0)
  const matched = words.reduce((sum, word) => sum + (lower.includes(word.text) ? word.weight : 0), 0)
  return matched > 0 && matched * 2 >= total ? matched : 0
}

/** The text a person would recognise as what was said in a stored user or assistant message. */
export function spoken(type: string, data: unknown) {
  if (typeof data !== "object" || data === null) return ""
  if (type === "user") return "text" in data && typeof data.text === "string" ? data.text : ""
  if (type !== "assistant" || !("content" in data) || !Array.isArray(data.content)) return ""
  return data.content
    .flatMap((part: unknown) =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part
        ? [String(part.text)]
        : [],
    )
    .join("\n")
}

/** A window of text around the first search word, cut on character boundaries. */
export function passage(text: string, words: ReadonlyArray<string>, width = 240) {
  const lower = text.toLowerCase()
  const at = Math.max(0, Math.min(...words.map((word) => lower.indexOf(word)).filter((index) => index >= 0)))
  const start = Math.max(0, at - Math.floor(width / 3))
  const characters = Array.from(text.slice(start))
  return `${start > 0 ? "…" : ""}${characters.slice(0, width).join("")}${characters.length > width ? "…" : ""}`
}

const pattern = (word: string) => `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`

const textHash = (text: string) => Hash.fast(text.trim().toLowerCase().replace(/\s+/g, " "))
// Separate from fact keys: suppressing deleted wording must not overwrite another live note.
const deletedTextPrefix = "deleted-text:"

export const layerWith = (platform: NodeJS.Platform = process.platform) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service

      const note = (row: typeof MemoryNoteTable.$inferSelect): Memory.Note => ({
        id: row.id,
        scope: row.scope,
        kind: row.kind,
        text: row.text,
        origin: row.origin,
        status: row.status,
        ...(row.verification ? { verification: row.verification } : {}),
        ...(row.session_id ? { sessionID: row.session_id } : {}),
        ...(row.seq === null ? {} : { seq: row.seq }),
        hits: row.hits,
        fileRevision: row.file_revision,
        ...(row.files === null
          ? {}
          : { files: Schema.decodeUnknownSync(Schema.Json)(MemoryFileEvidence.untrusted(row.files)) }),
        time: { created: row.time_created, updated: row.time_updated, observed: row.time_observed },
      })

      const find = (scope: Memory.Scope, key: string) =>
        db
          .select()
          .from(MemoryNoteTable)
          .where(and(eq(MemoryNoteTable.scope, scope), eq(MemoryNoteTable.key, key)))
          .get()
          .pipe(Effect.orDie)

      const legacy = (value: Memory.Scope) => platform !== "win32" && /^dir_[a-f0-9]{24}$/.test(value)
      const binding = (value: Memory.Scope) =>
        db.select().from(MemoryRecoveryTable).where(eq(MemoryRecoveryTable.scope, value)).get().pipe(Effect.orDie)
      const locate = Effect.fn("MemoryStore.scope")(function* (place: Place) {
        const value = scope(place, platform)
        if (platform === "win32" || place.project !== ProjectV2.ID.global) return value
        const existing = yield* binding(value)
        if (existing) {
          if (existing.directory !== place.directory) return yield* Effect.die("Memory directory identity conflict")
          // Authorization also runs inside deferred read transactions. Even an
          // INSERT that conflicts would acquire a writer lock and block another
          // connection before the allowance is reserved.
          return value
        }
        yield* db
          .insert(MemoryRecoveryTable)
          .values({
            scope: value,
            legacy_scope: scope(place, "win32"),
            directory: place.directory,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const row = yield* binding(value)
        if (row?.directory !== place.directory) return yield* Effect.die("Memory directory identity conflict")
        return value
      })
      const frozen = Effect.fn("MemoryStore.frozen")(function* (value: Memory.Scope) {
        if (legacy(value)) return true
        if (!value.startsWith("dir_posix_v2_")) return false
        const row = yield* binding(value)
        if (!row) return true
        if (row.state !== "pending") return false
        return !!(yield* db
          .select({ id: MemoryNoteTable.id })
          .from(MemoryNoteTable)
          .where(eq(MemoryNoteTable.scope, row.legacy_scope))
          .get()
          .pipe(Effect.orDie))
      })
      // An adjacent text alias does not prove it covers an old fact tombstone.
      const opaqueDeletion = (key: string) => !/^(?:deleted-text|text):[a-f0-9]{40}$/.test(key)
      const automaticFrozen = Effect.fn("MemoryStore.automaticFrozen")(function* (value: Memory.Scope) {
        const link = yield* binding(value)
        if (!link) return false
        const rows = yield* db
          .select({ key: MemoryNoteTable.key })
          .from(MemoryNoteTable)
          .where(and(eq(MemoryNoteTable.scope, link.legacy_scope), sql`${MemoryNoteTable.time_deleted} IS NOT NULL`))
          .all()
          .pipe(Effect.orDie)
        return rows.some((row) => opaqueDeletion(row.key))
      })
      const suppressed = Effect.fn("MemoryStore.suppressed")(function* (
        value: Memory.Scope,
        text: string,
        key?: string,
      ) {
        const keys = [deletedTextPrefix + textHash(text), `text:${textHash(text)}`, ...(key ? [key] : [])]
        const row = yield* binding(value)
        return !!(yield* db
          .select({ id: MemoryNoteTable.id })
          .from(MemoryNoteTable)
          .where(
            and(
              inArray(MemoryNoteTable.scope, row ? [value, row.legacy_scope] : [value]),
              inArray(MemoryNoteTable.key, keys),
              sql`${MemoryNoteTable.time_deleted} IS NOT NULL`,
            ),
          )
          .get()
          .pipe(Effect.orDie))
      })
      const claim = (id: Memory.ID) =>
        db
          .select()
          .from(MemoryRecoveryClaimTable)
          .where(eq(MemoryRecoveryClaimTable.note_id, id))
          .get()
          .pipe(Effect.orDie)
      const recovery = Effect.fn("MemoryStore.recovery")(function* (place: Place): Effect.fn.Return<Memory.Recovery> {
        const value = yield* locate(place)
        const link = yield* binding(value)
        if (!link)
          return {
            scope: value,
            directory: place.directory,
            frozen: false,
            automaticFrozen: false,
            state: "none",
            deleted: 0,
            notes: [],
          }
        const rows = yield* db
          .select()
          .from(MemoryNoteTable)
          .where(eq(MemoryNoteTable.scope, link.legacy_scope))
          .all()
          .pipe(Effect.orDie)
        return {
          scope: value,
          legacyScope: link.legacy_scope,
          directory: place.directory,
          frozen: rows.length > 0 && link.state === "pending",
          automaticFrozen: rows.some((row) => row.time_deleted !== null && opaqueDeletion(row.key)),
          state: rows.length ? link.state : "none",
          deleted: rows.filter((row) => row.time_deleted !== null).length,
          notes: yield* Effect.forEach(
            rows.filter((row) => row.time_deleted === null),
            (row) =>
              Effect.gen(function* () {
                const restored = !!(yield* claim(row.id))
                const blocked =
                  !row.text.trim() ||
                  row.text.length > 400 ||
                  !!(yield* find(value, row.key)) ||
                  (yield* suppressed(value, row.text, row.key))
                const source = row.session_id
                  ? yield* db
                      .select({ directory: SessionTable.directory })
                      .from(SessionTable)
                      .where(eq(SessionTable.id, row.session_id))
                      .get()
                      .pipe(Effect.orDie)
                  : undefined
                return {
                  note: note(row),
                  ...(source ? { sourceDirectory: source.directory } : {}),
                  restorable: !blocked && !restored,
                  restored,
                  reason: restored
                    ? "already assigned by the user; no duplicate recovery"
                    : blocked
                      ? "read only: deleted wording or unsupported legacy content"
                      : "source may mix directories; confirm ownership of this individual note",
                }
              }),
          ),
        }
      })
      const resolveRecovery = (place: Place, choice: Memory.RecoveryChoice) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              const value = yield* locate(place)
              const link = yield* binding(value)
              if (!link) return false
              if (
                !(yield* db
                  .select({ id: MemoryNoteTable.id })
                  .from(MemoryNoteTable)
                  .where(eq(MemoryNoteTable.scope, link.legacy_scope))
                  .get()
                  .pipe(Effect.orDie))
              )
                return false
              if (choice.decision === "blank" && choice.ids.length) return false
              if (choice.decision === "restore" && !choice.ids.length) return false
              const rows = yield* Effect.forEach([...new Set(choice.ids)], (id) =>
                db
                  .select()
                  .from(MemoryNoteTable)
                  .where(
                    and(
                      eq(MemoryNoteTable.id, id),
                      eq(MemoryNoteTable.scope, link.legacy_scope),
                      isNull(MemoryNoteTable.time_deleted),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie),
              )
              // Validate the whole explicit selection before making any new notes or unfreezing.
              for (const row of rows) {
                if (!row) return false
                const assigned = yield* claim(row.id)
                if (assigned?.scope === value) continue
                if (
                  assigned ||
                  !row.text.trim() ||
                  row.text.length > 400 ||
                  (yield* find(value, row.key)) ||
                  (yield* suppressed(value, row.text, row.key))
                )
                  return false
              }
              for (const row of rows) {
                if (!row || (yield* claim(row.id))) continue
                const id = Memory.ID.create()
                yield* db
                  .insert(MemoryRecoveryClaimTable)
                  .values({ note_id: row.id, scope: value, restored_id: id })
                  .run()
                  .pipe(Effect.orDie)
                yield* insert({
                  id,
                  scope: value,
                  key: row.key,
                  kind: row.kind,
                  text: row.text,
                  origin: "user",
                  status: "verified",
                  verification: "restored by explicit user confirmation; legacy source uncertain",
                  time_observed: Date.now(),
                })
              }
              yield* db
                .update(MemoryRecoveryTable)
                .set({ state: choice.decision === "blank" ? "blank" : "restored" })
                .where(eq(MemoryRecoveryTable.scope, value))
                .run()
                .pipe(Effect.orDie)
              return true
            }),
          )
          .pipe(Effect.orDie)

      const get = Effect.fn("MemoryStore.get")(function* (id: Memory.ID) {
        const row = yield* db
          .select()
          .from(MemoryNoteTable)
          .where(and(eq(MemoryNoteTable.id, id), isNull(MemoryNoteTable.time_deleted)))
          .get()
          .pipe(Effect.orDie)
        return row ? note(row) : undefined
      })

      const list = Effect.fn("MemoryStore.list")(function* (scope: Memory.Scope) {
        const rows = yield* db
          .select()
          .from(MemoryNoteTable)
          .where(and(eq(MemoryNoteTable.scope, scope), isNull(MemoryNoteTable.time_deleted)))
          .orderBy(desc(MemoryNoteTable.time_updated), desc(MemoryNoteTable.id))
          .all()
          .pipe(Effect.orDie)
        return rows.map(note)
      })

      // All observation results are computed outside this transaction by a future
      // authorized host producer. This layer only validates shape, scope and CAS.
      const fileUpdate = (input: MemoryFileEvidence.Bind | MemoryFileEvidence.Check) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              if (silent.has(input.scope) || (yield* frozen(input.scope)) || (yield* automaticFrozen(input.scope)))
                return false
              const row = yield* tx
                .select()
                .from(MemoryNoteTable)
                .where(
                  and(
                    eq(MemoryNoteTable.id, input.id),
                    eq(MemoryNoteTable.scope, input.scope),
                    eq(MemoryNoteTable.file_revision, input.expectedRevision),
                    isNull(MemoryNoteTable.time_deleted),
                  ),
                )
                .get()
              if (!row || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) return false
              // Unknown versions are preserved, never replaced by an older writer.
              if (row.files !== null) {
                const held = MemoryFileEvidence.decode(row.files)
                if (Option.isNone(held)) return false
                if ("files" in input && (held.value.state === "changed" || held.value.state === "missing")) return false
              }
              const files =
                "files" in input
                  ? MemoryFileEvidence.bindings(input.files)
                  : MemoryFileEvidence.compare(row.files, input.results)
              if (!files) return false
              const changed = files.state === "changed" || files.state === "missing"
              const updated = yield* tx
                .update(MemoryNoteTable)
                .set({
                  files,
                  file_revision: row.file_revision + 1,
                  ...(changed && !protectedByUser(row) ? { status: "stale" as const } : {}),
                })
                .where(
                  and(
                    eq(MemoryNoteTable.id, row.id),
                    eq(MemoryNoteTable.file_revision, input.expectedRevision),
                    isNull(MemoryNoteTable.time_deleted),
                  ),
                )
                .returning({ id: MemoryNoteTable.id })
                .get()
              return updated !== undefined
            }),
          )
          .pipe(Effect.orDie)

      const invalidateFiles: Interface["invalidateFiles"] = (input) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Recovery buckets are immutable. Reading them still masks persisted current.
              if ((yield* frozen(input.scope)) || (yield* automaticFrozen(input.scope))) return
              const rows = yield* tx
                .select()
                .from(MemoryNoteTable)
                .where(
                  and(
                    eq(MemoryNoteTable.scope, input.scope),
                    isNull(MemoryNoteTable.time_deleted),
                    isNotNull(MemoryNoteTable.files),
                  ),
                )
                .all()
              yield* Effect.forEach(rows, (row) =>
                Effect.gen(function* () {
                  const held = MemoryFileEvidence.decode(row.files)
                  if (Option.isNone(held)) return
                  if (
                    !(input.paths ?? [undefined]).some((path) =>
                      MemoryFileEvidence.affected(held.value, { directory: input.directory, path }, platform),
                    )
                  )
                    return
                  // Increment even unknown/alert rows: a check started before this hint must lose CAS.
                  yield* tx
                    .update(MemoryNoteTable)
                    .set({
                      files: MemoryFileEvidence.untrusted(row.files),
                      time_updated: row.time_updated,
                      file_revision: row.file_revision + 1,
                    })
                    .where(
                      and(
                        eq(MemoryNoteTable.id, row.id),
                        eq(MemoryNoteTable.file_revision, row.file_revision),
                        isNull(MemoryNoteTable.time_deleted),
                      ),
                    )
                    .run()
                }),
              )
            }),
          )
          .pipe(Effect.orDie, Effect.asVoid)

      const insert = (values: typeof MemoryNoteTable.$inferInsert) =>
        db
          .insert(MemoryNoteTable)
          .values(values)
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie, Effect.andThen(get(values.id)))

      const review = Effect.fn("MemoryStore.review")(function* (
        scope: Memory.Scope,
        decisions: ReadonlyArray<Decision>,
      ) {
        // Keep source/target protection and both writes in one snapshot, including against user edits.
        return yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              if ((yield* frozen(scope)) || (yield* automaticFrozen(scope)))
                return decisions.map((decision) => ({
                  id: decision.id,
                  result: "refused: resolve legacy memory recovery in Settings first",
                }))
              const held = (id: Memory.ID) =>
                tx
                  .select()
                  .from(MemoryNoteTable)
                  .where(
                    and(
                      eq(MemoryNoteTable.id, id),
                      eq(MemoryNoteTable.scope, scope),
                      isNull(MemoryNoteTable.time_deleted),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
              const change = (id: Memory.ID, values: Partial<typeof MemoryNoteTable.$inferInsert>) =>
                tx
                  .update(MemoryNoteTable)
                  .set({ ...values, file_revision: sql`${MemoryNoteTable.file_revision} + 1` })
                  .where(eq(MemoryNoteTable.id, id))
                  .run()
                  .pipe(Effect.orDie)
              return yield* Effect.forEach(decisions, (decision) =>
                Effect.gen(function* () {
                  const basis = decision.basis.trim().slice(0, 200)
                  const row = yield* held(decision.id)
                  if (!row) return { id: decision.id, result: "not found in this project" }
                  if (!basis) return { id: decision.id, result: "refused: say what the decision rests on" }
                  if (protectedByUser(row))
                    return { id: decision.id, result: "refused: written by the user; only the user changes it" }
                  if (decision.action === "verify") {
                    if (!MemoryFileEvidence.usable(note(row)))
                      return { id: decision.id, result: "refused: file dependencies need a fresh host check" }
                    yield* change(row.id, { status: "verified", verification: `checked: ${basis}` })
                    return { id: decision.id, result: "verified" }
                  }
                  if (decision.action === "stale") {
                    yield* change(row.id, { status: "stale", verification: `out of date: ${basis}` })
                    return { id: decision.id, result: "marked out of date" }
                  }
                  const target = decision.into && decision.into !== row.id ? yield* held(decision.into) : undefined
                  if (!target) return { id: decision.id, result: "refused: the note to merge into was not found" }
                  if (protectedByUser(target))
                    return {
                      id: decision.id,
                      result: "refused: merge target belongs to the user; only the user changes it",
                    }
                  const text = decision.text?.trim()
                  if (text && text.length <= 400) {
                    const deleted = yield* tx
                      .select()
                      .from(MemoryNoteTable)
                      .where(
                        and(
                          eq(MemoryNoteTable.scope, scope),
                          eq(MemoryNoteTable.key, deletedTextPrefix + textHash(text)),
                        ),
                      )
                      .get()
                      .pipe(Effect.orDie)
                    if (deleted || (yield* suppressed(scope, text)))
                      return { id: decision.id, result: "refused: wording was deleted by the user" }
                    yield* change(target.id, {
                      files: MemoryFileEvidence.edited(target.files),
                      text,
                      hits: target.hits + row.hits,
                      origin: "consolidation",
                      verification: `merged: ${basis}`,
                    })
                  }
                  // The duplicate keeps its key, so the same fact is not recorded again as a separate note.
                  yield* change(row.id, tombstone())
                  return { id: decision.id, result: `merged into ${target.id}` }
                }),
              )
            }),
          )
          .pipe(Effect.orDie)
      })

      const silent = new Set<Memory.Scope>()
      const silence = (scope: Memory.Scope, off: boolean) =>
        Effect.sync(() => {
          if (off) silent.add(scope)
          else silent.delete(scope)
        })

      const observe = Effect.fn("MemoryStore.observe")((input: ObserveInput) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              if (
                silent.has(input.scope) ||
                (yield* frozen(input.scope)) ||
                (yield* automaticFrozen(input.scope)) ||
                (yield* suppressed(input.scope, input.text, input.key))
              )
                return undefined
              if (input.key.startsWith(deletedTextPrefix)) return undefined
              if (yield* find(input.scope, deletedTextPrefix + textHash(input.text))) return undefined
              const existing = yield* find(input.scope, input.key)
              if (existing?.time_deleted) return undefined
              const now = Date.now()
              if (!existing)
                return yield* insert({
                  id: Memory.ID.create(),
                  scope: input.scope,
                  key: input.key,
                  kind: input.kind,
                  text: input.text,
                  origin: "program",
                  status: input.settled ? "verified" : "unverified",
                  verification: input.verification,
                  session_id: input.sessionID,
                  seq: input.seq,
                  time_observed: now,
                })
              // A person's edit outranks what the host sees later: keep their wording, only count the sighting.
              const edited = existing.origin !== "program" || protectedByUser(existing)
              yield* db
                .update(MemoryNoteTable)
                .set({
                  file_revision: sql`${MemoryNoteTable.file_revision} + 1`,
                  hits: existing.hits + 1,
                  time_observed: now,
                  ...(edited
                    ? {}
                    : {
                        files:
                          input.text === existing.text ? existing.files : MemoryFileEvidence.edited(existing.files),
                        text: input.text,
                        verification: input.verification,
                        session_id: input.sessionID,
                        seq: input.seq,
                        // One success says the command worked once. Seen again in another conversation, it is a practice.
                        status:
                          existing.status === "stale"
                            ? "stale"
                            : input.settled || existing.status === "verified" || existing.session_id !== input.sessionID
                              ? "verified"
                              : existing.status,
                      }),
                })
                .where(eq(MemoryNoteTable.id, existing.id))
                .run()
                .pipe(Effect.orDie)
              return yield* get(existing.id)
            }),
          )
          .pipe(Effect.orDie),
      )

      const write = Effect.fn("MemoryStore.write")((input: WriteInput) =>
        db
          .transaction(() =>
            Effect.gen(function* () {
              if ((yield* frozen(input.scope)) || (input.origin !== "user" && (yield* automaticFrozen(input.scope))))
                return undefined
              const text = input.text.trim()
              const files = input.readFiles === undefined ? undefined : MemoryFileEvidence.bindings(input.readFiles)
              if (
                input.readFiles !== undefined &&
                (!files ||
                  input.origin !== "model" ||
                  input.status !== "unverified" ||
                  !input.sessionID ||
                  !Number.isSafeInteger(input.seq) ||
                  files.files.some((file) => file.sessionID !== input.sessionID || file.seq >= input.seq!))
              )
                return undefined
              if (
                input.extractedMessageID &&
                (input.origin !== "consolidation" || !input.sessionID || input.seq === undefined)
              )
                return undefined
              // Keep the source key after edits/deletion without retaining readable provenance.
              // Quotes, digests and model wording must not let a retry escape its tombstone.
              const key = input.extractedMessageID
                ? `extracted:${Hash.sha256(JSON.stringify([input.sessionID, input.extractedMessageID, input.seq]))}`
                : `text:${textHash(text)}`
              if (yield* suppressed(input.scope, text, key)) return undefined
              if (!text) return undefined
              if (yield* find(input.scope, deletedTextPrefix + textHash(text))) return undefined
              const existing = yield* find(input.scope, key)
              if (existing?.time_deleted) return undefined
              if (existing && files) {
                // Never backfill an old or user-owned note merely because its
                // wording matches. An exact source retry keeps the original row.
                const previous = MemoryFileEvidence.decode(existing.files)
                return existing.origin === "model" &&
                  existing.text === text &&
                  existing.session_id === input.sessionID &&
                  existing.seq === input.seq &&
                  Option.isSome(previous) &&
                  JSON.stringify(previous.value.files) === JSON.stringify(files.files)
                  ? note(existing)
                  : undefined
              }
              if (existing)
                return input.origin === "user" && !protectedByUser(existing)
                  ? yield* edit(existing.id, { text, kind: input.kind, status: input.status })
                  : note(existing)
              return yield* insert({
                id: Memory.ID.create(),
                scope: input.scope,
                key,
                kind: input.kind,
                text,
                origin: input.origin,
                status: input.status,
                verification: input.verification,
                session_id: input.sessionID,
                seq: input.seq,
                time_observed: Date.now(),
                ...(files ? { files, file_revision: 1 } : {}),
              })
            }),
          )
          .pipe(Effect.orDie),
      )

      const edit = Effect.fn("MemoryStore.edit")(function* (id: Memory.ID, input: EditInput) {
        return yield* db
          .transaction(() =>
            Effect.gen(function* () {
              const current = yield* get(id)
              if (
                !current ||
                (yield* frozen(current.scope)) ||
                (input.text && (yield* suppressed(current.scope, input.text)))
              )
                return undefined
              const text = input.text?.trim()
              yield* db
                .update(MemoryNoteTable)
                .set({
                  file_revision: sql`${MemoryNoteTable.file_revision} + 1`,
                  ...(text
                    ? { text, status: "verified" as const, files: MemoryFileEvidence.edited(current.files ?? null) }
                    : {}),
                  ...(text || input.status === "verified"
                    ? { origin: "user" as const, verification: text ? "edited by the user" : "confirmed by the user" }
                    : {}),
                  ...(input.kind ? { kind: input.kind } : {}),
                  ...(input.status ? { status: input.status } : {}),
                })
                .where(and(eq(MemoryNoteTable.id, id), isNull(MemoryNoteTable.time_deleted)))
                .run()
                .pipe(Effect.orDie)
              return yield* get(id)
            }),
          )
          .pipe(Effect.orDie)
      })

      // The original fact key survives; the separate alias also suppresses edited wording.
      // Both rows keep no readable text or provenance from the removed note.
      const tombstone = () => ({
        time_deleted: Date.now(),
        text: "",
        verification: null,
        session_id: null,
        seq: null,
        files: null,
      })

      const erase = (condition: ReturnType<typeof eq>) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              const rows = yield* tx
                .select()
                .from(MemoryNoteTable)
                .where(and(condition, isNull(MemoryNoteTable.time_deleted)))
                .all()
                .pipe(Effect.orDie)
              yield* Effect.forEach(
                rows.filter((row) => !legacy(row.scope)),
                (row) =>
                  Effect.gen(function* () {
                    if (row.text.trim())
                      yield* tx
                        .insert(MemoryNoteTable)
                        .values({
                          id: Memory.ID.create(),
                          scope: row.scope,
                          key: deletedTextPrefix + textHash(row.text),
                          kind: row.kind,
                          origin: "program",
                          status: "unverified",
                          time_observed: Date.now(),
                          ...tombstone(),
                        })
                        .onConflictDoNothing()
                        .run()
                        .pipe(Effect.orDie)
                    yield* tx
                      .update(MemoryNoteTable)
                      .set({ ...tombstone(), file_revision: sql`${MemoryNoteTable.file_revision} + 1` })
                      .where(eq(MemoryNoteTable.id, row.id))
                      .run()
                      .pipe(Effect.orDie)
                  }),
              )
            }),
          )
          .pipe(Effect.orDie)

      const remove = Effect.fn("MemoryStore.remove")((id: Memory.ID) => erase(eq(MemoryNoteTable.id, id)))
      const clear = Effect.fn("MemoryStore.clear")((scope: Memory.Scope) => erase(eq(MemoryNoteTable.scope, scope)))

      const search = Effect.fn("MemoryStore.search")(function* (input: SearchInput) {
        const words = terms(input.query)
        if (words.length === 0) return { notes: [], sessions: [] }
        const limit = Math.max(1, Math.min(input.limit ?? 5, 10))
        const notes = (yield* db
          .select()
          .from(MemoryNoteTable)
          .where(
            and(
              or(eq(MemoryNoteTable.scope, input.scope), eq(MemoryNoteTable.scope, Memory.Scope.user)),
              isNull(MemoryNoteTable.time_deleted),
            ),
          )
          .all()
          .pipe(Effect.orDie))
          .map((row) => ({ row, score: relevance(row.text, words) }))
          .filter((item) => item.score > 0)
          .toSorted((left, right) => right.score - left.score || right.row.time_observed - left.row.time_observed)
          .slice(0, limit * 2)
          .map((item) => note(item.row))
        const place = input.place
        if (!place) return { notes, sessions: [] }
        // The stored JSON also holds tool input and output, so a row that matches here is only a
        // candidate; what counts is how much of the query was actually said.
        const rows = yield* db
          .select({
            session_id: SessionMessageTable.session_id,
            type: SessionMessageTable.type,
            data: SessionMessageTable.data,
            time: SessionMessageTable.time_created,
            title: SessionTable.title,
          })
          .from(SessionMessageTable)
          .innerJoin(SessionTable, eq(SessionTable.id, SessionMessageTable.session_id))
          .where(
            and(
              eq(SessionTable.project_id, place.project),
              ...(place.project === ProjectV2.ID.global ? [eq(SessionTable.directory, place.directory)] : []),
              inArray(SessionMessageTable.type, ["user", "assistant"]),
              ...(input.exclude ? [ne(SessionMessageTable.session_id, input.exclude)] : []),
              or(
                ...words.map((word) => sql`lower(${SessionMessageTable.data}) LIKE ${pattern(word.text)} ESCAPE '\\'`),
              ),
            ),
          )
          .orderBy(desc(SessionMessageTable.time_created))
          .limit(400)
          .all()
          .pipe(Effect.orDie)
        const sessions = rows.reduce(
          (found, row) => {
            const text = spoken(row.type, row.data)
            const score = relevance(text, words)
            if (score === 0) return found
            const match = found.get(row.session_id) ?? {
              sessionID: row.session_id,
              title: row.title,
              time: row.time,
              score: 0,
              passages: [] as Array<{ role: string; text: string; score: number }>,
            }
            match.score = Math.max(match.score, score)
            match.passages.push({
              role: row.type,
              text: passage(
                text,
                words.map((word) => word.text),
              ),
              score,
            })
            return found.set(row.session_id, match)
          },
          new Map<
            SessionSchema.ID,
            {
              sessionID: SessionSchema.ID
              title: string
              time: number
              score: number
              passages: Array<{ role: string; text: string; score: number }>
            }
          >(),
        )
        return {
          notes,
          sessions: Array.from(sessions.values())
            .toSorted((left, right) => right.score - left.score || right.time - left.time)
            .slice(0, limit)
            .map((match) => ({
              sessionID: match.sessionID,
              title: match.title,
              time: match.time,
              passages: match.passages
                .toSorted((left, right) => right.score - left.score)
                .slice(0, 3)
                .map((item) => ({ role: item.role, text: item.text })),
            })),
        }
      })

      return Service.of({
        scope: locate,
        recovery,
        resolveRecovery,
        canAutomate: (scope) =>
          frozen(scope).pipe(
            Effect.flatMap((held) =>
              held ? Effect.succeed(false) : automaticFrozen(scope).pipe(Effect.map((held) => !held)),
            ),
          ),
        list,
        get,
        observe,
        write,
        bindFiles: fileUpdate,
        checkFiles: fileUpdate,
        canCheckFiles: (scope) =>
          Effect.gen(function* () {
            return !silent.has(scope) && !(yield* frozen(scope)) && !(yield* automaticFrozen(scope))
          }),
        invalidateFiles,
        edit,
        remove,
        clear,
        review,
        silence,
        search,
      })
    }),
  )

export const node = makeGlobalNode({ service: Service, layer: layerWith(), deps: [Database.node] })
