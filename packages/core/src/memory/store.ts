export * as MemoryStore from "./store"

import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Memory } from "@zaovra-ai/schema/memory"
import { Database } from "../database/database"
import { ProjectV2 } from "../project"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"
import { SessionMessageTable, SessionTable } from "../session/sql"
import { Hash } from "../util/hash"
import { MemoryNoteTable } from "./sql"

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
export function scope(place: Place) {
  if (place.project !== ProjectV2.ID.global) return Memory.Scope.make(place.project)
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
  /** Notes of one scope, newest first. Deleted notes are never returned. */
  readonly list: (scope: Memory.Scope) => Effect.Effect<ReadonlyArray<Memory.Note>>
  readonly get: (id: Memory.ID) => Effect.Effect<Memory.Note | undefined>
  /** Records a fact the host saw for itself. A fact the user deleted stays deleted. */
  readonly observe: (input: ObserveInput) => Effect.Effect<Memory.Note | undefined>
  readonly write: (input: WriteInput) => Effect.Effect<Memory.Note | undefined>
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

const layer = Layer.effect(
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
      time: { created: row.time_created, updated: row.time_updated, observed: row.time_observed },
    })

    const find = (scope: Memory.Scope, key: string) =>
      db
        .select()
        .from(MemoryNoteTable)
        .where(and(eq(MemoryNoteTable.scope, scope), eq(MemoryNoteTable.key, key)))
        .get()
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

    const insert = (values: typeof MemoryNoteTable.$inferInsert) =>
      db
        .insert(MemoryNoteTable)
        .values(values)
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie, Effect.andThen(get(values.id)))

    const review = Effect.fn("MemoryStore.review")(function* (scope: Memory.Scope, decisions: ReadonlyArray<Decision>) {
      const held = (id: Memory.ID) =>
        db
          .select()
          .from(MemoryNoteTable)
          .where(
            and(eq(MemoryNoteTable.id, id), eq(MemoryNoteTable.scope, scope), isNull(MemoryNoteTable.time_deleted)),
          )
          .get()
          .pipe(Effect.orDie)
      const change = (id: Memory.ID, values: Partial<typeof MemoryNoteTable.$inferInsert>) =>
        db.update(MemoryNoteTable).set(values).where(eq(MemoryNoteTable.id, id)).run().pipe(Effect.orDie)
      return yield* Effect.forEach(decisions, (decision) =>
        Effect.gen(function* () {
          const basis = decision.basis.trim().slice(0, 200)
          const row = yield* held(decision.id)
          if (!row) return { id: decision.id, result: "not found in this project" }
          if (!basis) return { id: decision.id, result: "refused: say what the decision rests on" }
          if (row.origin === "user")
            return { id: decision.id, result: "refused: written by the user; only the user changes it" }
          if (decision.action === "verify") {
            yield* change(row.id, { status: "verified", verification: `checked: ${basis}` })
            return { id: decision.id, result: "verified" }
          }
          if (decision.action === "stale") {
            yield* change(row.id, { status: "stale", verification: `out of date: ${basis}` })
            return { id: decision.id, result: "marked out of date" }
          }
          const target = decision.into && decision.into !== row.id ? yield* held(decision.into) : undefined
          if (!target) return { id: decision.id, result: "refused: the note to merge into was not found" }
          const text = decision.text?.trim()
          if (text && text.length <= 400 && target.origin !== "user")
            yield* change(target.id, { text, hits: target.hits + row.hits })
          // The duplicate keeps its key, so the same fact is not recorded again as a separate note.
          yield* change(row.id, tombstone())
          return { id: decision.id, result: `merged into ${target.id}` }
        }),
      )
    })

    const silent = new Set<Memory.Scope>()
    const silence = (scope: Memory.Scope, off: boolean) =>
      Effect.sync(() => {
        if (off) silent.add(scope)
        else silent.delete(scope)
      })

    const observe = Effect.fn("MemoryStore.observe")(function* (input: ObserveInput) {
      if (silent.has(input.scope)) return undefined
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
      const edited = existing.origin !== "program"
      yield* db
        .update(MemoryNoteTable)
        .set({
          hits: existing.hits + 1,
          time_observed: now,
          ...(edited
            ? {}
            : {
                text: input.text,
                verification: input.verification,
                session_id: input.sessionID,
                seq: input.seq,
                // One success says the command worked once. Seen again in another conversation, it is a practice.
                status:
                  input.settled || existing.status === "verified" || existing.session_id !== input.sessionID
                    ? "verified"
                    : existing.status,
              }),
        })
        .where(eq(MemoryNoteTable.id, existing.id))
        .run()
        .pipe(Effect.orDie)
      return yield* get(existing.id)
    })

    const write = Effect.fn("MemoryStore.write")(function* (input: WriteInput) {
      const text = input.text.trim()
      if (!text) return undefined
      const key = `text:${Hash.fast(text.toLowerCase().replace(/\s+/g, " "))}`
      const existing = yield* find(input.scope, key)
      if (existing) return existing.time_deleted ? undefined : note(existing)
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
      })
    })

    const edit = Effect.fn("MemoryStore.edit")(function* (id: Memory.ID, input: EditInput) {
      const text = input.text?.trim()
      yield* db
        .update(MemoryNoteTable)
        .set({
          ...(text
            ? { text, origin: "user" as const, status: "verified" as const, verification: "edited by the user" }
            : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.status ? { status: input.status } : {}),
        })
        .where(and(eq(MemoryNoteTable.id, id), isNull(MemoryNoteTable.time_deleted)))
        .run()
        .pipe(Effect.orDie)
      return yield* get(id)
    })

    // Deleting keeps the row as a tombstone with its text blanked: the key alone stops the same
    // fact from being recorded again, and nothing the user removed stays readable.
    const tombstone = () => ({ time_deleted: Date.now(), text: "", verification: null, session_id: null, seq: null })

    const remove = Effect.fn("MemoryStore.remove")(function* (id: Memory.ID) {
      yield* db
        .update(MemoryNoteTable)
        .set(tombstone())
        .where(and(eq(MemoryNoteTable.id, id), isNull(MemoryNoteTable.time_deleted)))
        .run()
        .pipe(Effect.orDie)
    })

    const clear = Effect.fn("MemoryStore.clear")(function* (scope: Memory.Scope) {
      yield* db
        .update(MemoryNoteTable)
        .set(tombstone())
        .where(and(eq(MemoryNoteTable.scope, scope), isNull(MemoryNoteTable.time_deleted)))
        .run()
        .pipe(Effect.orDie)
    })

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
            or(...words.map((word) => sql`lower(${SessionMessageTable.data}) LIKE ${pattern(word.text)} ESCAPE '\\'`)),
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

    return Service.of({ list, get, observe, write, edit, remove, clear, review, silence, search })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
