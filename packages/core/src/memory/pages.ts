export * as MemoryPages from "./pages"

import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Memory } from "@zaovra-ai/schema/memory"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Hash } from "../util/hash"
import { MemoryPageTable, MemoryPageTombstoneTable } from "./pages.sql"
import { MemoryStore } from "./store"
import { MemoryTidyStore } from "./tidy-store"

export class Rejected extends Schema.TaggedErrorClass<Rejected>()("MemoryPages.Rejected", {
  reason: Schema.Literals(["invalid", "source", "deleted", "conflict", "limit"]),
}) {}

export interface Publish {
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly sources: ReadonlyArray<{ readonly id: Memory.ID; readonly digest: string }>
  /** Required to replace a page; an identical retry is safe even after its revision changed. */
  readonly expected?: string
}

export interface Interface {
  readonly sources: (
    scope: Memory.Scope,
  ) => Effect.Effect<ReadonlyArray<{ note: Memory.Note; source: Memory.PageSource }>>
  readonly list: (scope: Memory.Scope) => Effect.Effect<ReadonlyArray<Memory.Page>>
  readonly get: (scope: Memory.Scope, id: Memory.PageID) => Effect.Effect<Memory.Page | undefined>
  readonly publish: (
    authority: MemoryTidyStore.Authority,
    input: Publish,
  ) => Effect.Effect<Memory.Page, Rejected | MemoryTidyStore.Rejected>
  /** User-only operations; model tools never expose removal or clearing. */
  readonly remove: (scope: Memory.Scope, id: Memory.PageID) => Effect.Effect<void>
  readonly clear: (scope: Memory.Scope) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/MemoryPages") {}

export function source(note: Memory.Note): Memory.PageSource {
  return {
    id: note.id,
    digest: Hash.sha256(
      JSON.stringify([
        note.id,
        note.scope,
        note.kind,
        note.text,
        note.origin,
        note.status,
        note.verification,
        note.sessionID,
        note.seq,
      ]),
    ),
    ...(note.sessionID ? { sessionID: note.sessionID } : {}),
    ...(note.seq === undefined ? {} : { seq: note.seq }),
  }
}

const normalized = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ")
const titleKey = (title: string) => "title:" + Hash.sha256(normalized(title))
const bodyKey = (body: string) => "body:" + Hash.sha256(normalized(body))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const memory = yield* MemoryStore.Service
    const tidy = yield* MemoryTidyStore.Service
    const db = database.db
    const rows = (scope: Memory.Scope) =>
      db
        .select()
        .from(MemoryPageTable)
        .where(and(eq(MemoryPageTable.scope, scope), isNull(MemoryPageTable.time_deleted)))
        .orderBy(desc(MemoryPageTable.time_updated))
        .all()
        .pipe(Effect.orDie)
    const sources = (scope: Memory.Scope) =>
      memory
        .list(scope)
        .pipe(
          Effect.map((notes) =>
            notes.filter((note) => note.status === "verified").map((note) => ({ note, source: source(note) })),
          ),
        )
    const view = (row: typeof MemoryPageTable.$inferSelect, notes: ReadonlyMap<Memory.ID, string>): Memory.Page => ({
      id: row.id,
      scope: row.scope,
      title: row.title,
      summary: row.summary,
      body: row.body,
      sources: row.sources,
      revision: row.revision,
      status:
        row.sources.length > 0 && row.sources.every((item) => notes.get(item.id) === item.digest) ? "current" : "stale",
      time: { created: row.time_created, updated: row.time_updated },
    })
    const list = (scope: Memory.Scope) =>
      db
        .transaction(() =>
          Effect.gen(function* () {
            const notes = new Map((yield* sources(scope)).map((item) => [item.source.id, item.source.digest]))
            return (yield* rows(scope)).map((row) => view(row, notes))
          }),
        )
        .pipe(Effect.orDie)
    const erase = (scope: Memory.Scope, id?: Memory.PageID) =>
      db
        .transaction(() =>
          Effect.gen(function* () {
            const held = (yield* rows(scope)).filter((row) => id === undefined || row.id === id)
            for (const row of held) {
              yield* db
                .insert(MemoryPageTombstoneTable)
                .values(
                  Array.from(new Set([row.key, ...row.aliases, bodyKey(row.body)])).map((key) => ({
                    scope,
                    key,
                    time_created: Date.now(),
                  })),
                )
                .onConflictDoNothing()
                .run()
              yield* db
                .update(MemoryPageTable)
                .set({
                  title: "",
                  summary: "",
                  body: "",
                  sources: [],
                  aliases: [],
                  revision: "",
                  time_deleted: Date.now(),
                })
                .where(and(eq(MemoryPageTable.scope, scope), eq(MemoryPageTable.id, row.id)))
                .run()
            }
          }),
        )
        .pipe(Effect.orDie)
    return Service.of({
      sources,
      list,
      get: (scope, id) => list(scope).pipe(Effect.map((pages) => pages.find((page) => page.id === id))),
      remove: erase,
      clear: (scope) => erase(scope),
      publish: (authority, input) =>
        tidy.guarded(
          authority,
          Effect.gen(function* () {
            const title = input.title.trim()
            const summary = input.summary.trim()
            const body = input.body.trim()
            if (
              !title ||
              title.length > 120 ||
              !summary ||
              Buffer.byteLength(summary) > 512 ||
              !body ||
              Buffer.byteLength(body) > 16_384 ||
              input.sources.length === 0 ||
              input.sources.length > 20 ||
              new Set(input.sources.map((item) => item.id)).size !== input.sources.length
            )
              return yield* new Rejected({ reason: "invalid" })
            const notes = new Map((yield* sources(authority.scope)).map((item) => [item.source.id, item.source]))
            if (input.sources.some((item) => notes.get(item.id)?.digest !== item.digest))
              return yield* new Rejected({ reason: "source" })
            const captured = input.sources
              .map((item) => notes.get(item.id)!)
              .toSorted((a, b) => a.id.localeCompare(b.id))
            const key = titleKey(title)
            const alias = bodyKey(body)
            const deleted = yield* db
              .select()
              .from(MemoryPageTombstoneTable)
              .where(
                and(
                  eq(MemoryPageTombstoneTable.scope, authority.scope),
                  inArray(MemoryPageTombstoneTable.key, [key, alias]),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (deleted) return yield* new Rejected({ reason: "deleted" })
            const existing = yield* db
              .select()
              .from(MemoryPageTable)
              .where(and(eq(MemoryPageTable.scope, authority.scope), eq(MemoryPageTable.key, key)))
              .get()
              .pipe(Effect.orDie)
            if (existing?.time_deleted !== undefined && existing.time_deleted !== null)
              return yield* new Rejected({ reason: "deleted" })
            const revision = Hash.sha256(JSON.stringify([title, summary, body, captured]))
            if (existing?.revision === revision)
              return view(existing, new Map(captured.map((item) => [item.id, item.digest])))
            if (existing ? input.expected !== existing.revision : input.expected !== undefined)
              return yield* new Rejected({ reason: "conflict" })
            if (!existing && (yield* rows(authority.scope)).length >= 100)
              return yield* new Rejected({ reason: "limit" })
            const value = {
              title,
              summary,
              body,
              sources: captured,
              revision,
              aliases: Array.from(new Set([...(existing?.aliases ?? []), alias])),
              time_updated: Date.now(),
            }
            const row = existing
              ? yield* db
                  .update(MemoryPageTable)
                  .set(value)
                  .where(eq(MemoryPageTable.id, existing.id))
                  .returning()
                  .get()
                  .pipe(Effect.orDie)
              : yield* db
                  .insert(MemoryPageTable)
                  .values({ ...value, id: Memory.PageID.create(), scope: authority.scope, key })
                  .returning()
                  .get()
                  .pipe(Effect.orDie)
            return view(row, new Map(captured.map((item) => [item.id, item.digest])))
          }),
        ),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, MemoryStore.node, MemoryTidyStore.node],
})
