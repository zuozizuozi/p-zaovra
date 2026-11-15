import { expect, test } from "bun:test"
import path from "node:path"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Exit, ManagedRuntime } from "effect"
import { Memory } from "@zaovra-ai/schema/memory"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import migration from "../src/database/migration/20261115181429_memory-pages"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { MemoryPages } from "../src/memory/pages"
import { MemoryPageTable } from "../src/memory/pages.sql"
import { MemoryStore } from "../src/memory/store"
import { MemoryTidyStore } from "../src/memory/tidy-store"
import { ModelV2 } from "../src/model"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath, RelativePath } from "../src/schema"
import { SessionEvent } from "../src/session/event"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const nodes = LayerNode.group([
  MemoryPages.node,
  MemoryStore.node,
  MemoryTidyStore.node,
  Database.node,
  EventV2.node,
  SessionProjector.node,
])
const it = testEffect(AppNodeBuilder.build(nodes))
const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  const memory = yield* MemoryStore.Service
  const pages = yield* MemoryPages.Service
  const tidy = yield* MemoryTidyStore.Service
  const events = yield* EventV2.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const model = { id: ModelV2.ID.make("offline"), providerID: ProviderV2.ID.make("offline") }
  const run = yield* tidy.create(
    { requestID: "pages", scope: Memory.Scope.user, directory: "/memory-pages", model, tokens: 200, dailyTokens: 300 },
    (sessionID) =>
      events
        .publish(SessionEvent.Created, {
          sessionID,
          timestamp: DateTime.makeUnsafe(0),
          projectID: Project.ID.global,
          location: { directory: AbsolutePath.make("/memory-pages") },
          subpath: RelativePath.make("memory-pages"),
          title: "Memory pages",
          slug: "memory-pages",
          version: "test",
          model,
        })
        .pipe(
          Effect.andThen(
            SessionInput.admit(database.db, events, {
              id: SessionMessage.ID.create(),
              sessionID,
              prompt: { text: "Tidy" },
              delivery: "steer",
            }),
          ),
          Effect.map((input) => ({ id: input.id, seq: input.admittedSeq })),
        ),
  )
  const note = yield* memory.write({
    scope: Memory.Scope.user,
    kind: "practice",
    origin: "user",
    status: "verified",
    text: "Use the isolated local test database",
    verification: "written by the user",
    sessionID: run.session_id,
    seq: 1,
  })
  if (!note) throw new Error("source fixture missing")
  const input = {
    title: "Testing",
    summary: "Use isolated test data.",
    body: "Run tests against an isolated database.",
    sources: [MemoryPages.source(note)],
  }
  return {
    database,
    memory,
    pages,
    tidy,
    run,
    note,
    input,
    authority: { sessionID: run.session_id, scope: Memory.Scope.user, enabled: true },
  }
})

it.live("page publication is user-confirmed, scope-bound and revoked with the tidy task", () =>
  Effect.gen(function* () {
    const h = yield* setup
    for (const authority of [
      { ...h.authority, enabled: false },
      { ...h.authority, sessionID: SessionSchema.ID.make("ses_ordinary") },
      { ...h.authority, scope: Memory.Scope.make("other-project") },
    ]) {
      expect(Exit.isFailure(yield* h.pages.publish(authority, h.input).pipe(Effect.exit))).toBe(true)
    }
    expect(yield* h.pages.list(h.authority.scope)).toEqual([])
    const page = yield* h.pages.publish(h.authority, h.input)
    expect(page.status).toBe("current")
    expect(page.sources[0]).toEqual(MemoryPages.source(h.note))
    expect(yield* h.pages.get(Memory.Scope.make("other-project"), page.id)).toBeUndefined()
    yield* h.tidy.finish(h.run.id, "cancelled")
    expect(
      Exit.isFailure(yield* h.pages.publish(h.authority, { ...h.input, title: "Another" }).pipe(Effect.exit)),
    ).toBe(true)
    expect(yield* h.pages.list(h.authority.scope)).toHaveLength(1)
  }),
)

it.live("knowledge pages reject unchecked, cross-scope, changed and duplicate sources", () =>
  Effect.gen(function* () {
    const h = yield* setup
    const unchecked = yield* h.memory.write({
      scope: Memory.Scope.user,
      text: "An unchecked suggestion",
      kind: "practice",
      origin: "model",
      status: "unverified",
    })
    const foreign = yield* h.memory.write({
      scope: Memory.Scope.make("foreign"),
      text: "Private in another project",
      kind: "practice",
      origin: "user",
      status: "verified",
    })
    if (!unchecked || !foreign) throw new Error("source fixture missing")
    for (const sources of [
      [],
      [MemoryPages.source(unchecked)],
      [MemoryPages.source(foreign)],
      [{ id: h.note.id, digest: "not the host fingerprint" }],
      [MemoryPages.source(h.note), MemoryPages.source(h.note)],
    ]) {
      expect(Exit.isFailure(yield* h.pages.publish(h.authority, { ...h.input, sources }).pipe(Effect.exit))).toBe(true)
    }
    expect(yield* h.pages.list(h.authority.scope)).toEqual([])
    const page = yield* h.pages.publish(h.authority, h.input)
    const changed = yield* h.memory.edit(h.note.id, { text: "Use a new local test setup" })
    if (!changed) throw new Error("edited fixture missing")
    expect((yield* h.pages.get(h.authority.scope, page.id))?.status).toBe("stale")
    expect(Exit.isFailure(yield* h.pages.publish(h.authority, h.input).pipe(Effect.exit))).toBe(true)
    const updated = yield* h.pages.publish(h.authority, {
      ...h.input,
      expected: page.revision,
      sources: [MemoryPages.source(changed)],
    })
    expect(updated.status).toBe("current")
    yield* h.memory.remove(h.note.id)
    expect((yield* h.pages.get(h.authority.scope, page.id))?.status).toBe("stale")
    expect(
      Exit.isFailure(
        yield* h.pages
          .publish(h.authority, { ...h.input, title: "Renamed", sources: updated.sources })
          .pipe(Effect.exit),
      ),
    ).toBe(true)
  }),
)

it.live("same-content retries are idempotent, concurrent replacements require the current revision", () =>
  Effect.gen(function* () {
    const h = yield* setup
    const first = yield* h.pages.publish(h.authority, h.input)
    expect(yield* h.pages.publish(h.authority, h.input)).toEqual(first)
    const results = yield* Effect.all(
      ["Use setup A", "Use setup B"].map((body) =>
        h.pages.publish(h.authority, { ...h.input, expected: first.revision, body }).pipe(Effect.exit),
      ),
      { concurrency: "unbounded" },
    )
    expect(results.filter(Exit.isSuccess)).toHaveLength(1)
    expect(results.filter(Exit.isFailure)).toHaveLength(1)
    expect(yield* h.pages.list(h.authority.scope)).toHaveLength(1)
    const current = (yield* h.pages.list(h.authority.scope))[0]!
    expect(yield* h.pages.publish(h.authority, { ...h.input, expected: first.revision, body: current.body })).toEqual(
      current,
    )
    expect(
      Exit.isFailure(yield* h.pages.publish(h.authority, { ...h.input, body: "Blind replacement" }).pipe(Effect.exit)),
    ).toBe(true)
  }),
)

it.live("a typed page rejection rolls back all changes inside the granted transaction", () =>
  Effect.gen(function* () {
    const h = yield* setup
    const result = yield* h.tidy
      .guarded(
        h.authority,
        Effect.gen(function* () {
          yield* h.memory.edit(h.note.id, { text: "This edit must roll back" })
          return yield* new MemoryPages.Rejected({ reason: "source" })
        }),
      )
      .pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    expect((yield* h.memory.get(h.note.id))?.text).toBe(h.note.text)
  }),
)

it.live("deleting a page suppresses all published wordings and clears stored text without touching source notes", () =>
  Effect.gen(function* () {
    const h = yield* setup
    const first = yield* h.pages.publish(h.authority, h.input)
    const second = yield* h.pages.publish(h.authority, {
      ...h.input,
      expected: first.revision,
      body: "The revised testing guide",
    })
    yield* h.pages.remove(h.authority.scope, first.id)
    yield* h.pages.remove(h.authority.scope, first.id)
    expect(yield* h.pages.list(h.authority.scope)).toEqual([])
    expect(yield* h.memory.get(h.note.id)).toBeDefined()
    for (const input of [
      h.input,
      { ...h.input, title: "new title" },
      { ...h.input, title: "newer title", body: " THE   REVISED TESTING GUIDE " },
      { ...h.input, body: "new content" },
    ]) {
      expect(Exit.isFailure(yield* h.pages.publish(h.authority, input).pipe(Effect.exit))).toBe(true)
    }
    const row = yield* h.database.db
      .select()
      .from(MemoryPageTable)
      .where(eq(MemoryPageTable.id, second.id))
      .get()
      .pipe(Effect.orDie)
    expect(row).toMatchObject({ title: "", summary: "", body: "", sources: [], aliases: [], revision: "" })
    expect(row?.time_deleted).not.toBeNull()
    yield* h.pages.publish(h.authority, { ...h.input, title: "different topic", body: "a distinct guide" })
    yield* h.pages.clear(h.authority.scope)
    expect(yield* h.pages.list(h.authority.scope)).toEqual([])
    expect(
      Exit.isFailure(
        yield* h.pages.publish(h.authority, { ...h.input, title: "copy", body: "a distinct guide" }).pipe(Effect.exit),
      ),
    ).toBe(true)
  }),
)

test("pages and deletion tombstones survive a real SQLite reopen", async () => {
  await using temp = await tmpdir()
  const runtime = () =>
    ManagedRuntime.make(
      AppNodeBuilder.build(nodes, [[Database.node, Database.layerFromPath(path.join(temp.path, "pages.db"))]]),
    )
  const first = runtime()
  const saved = await first
    .runPromise(
      Effect.gen(function* () {
        const h = yield* setup
        const page = yield* h.pages.publish(h.authority, h.input)
        return { page, input: h.input, authority: h.authority }
      }),
    )
    .finally(() => first.dispose())
  const second = runtime()
  await second
    .runPromise(
      Effect.gen(function* () {
        const pages = yield* MemoryPages.Service
        expect(yield* pages.get(saved.authority.scope, saved.page.id)).toEqual(saved.page)
        yield* pages.remove(saved.authority.scope, saved.page.id)
      }),
    )
    .finally(() => second.dispose())
  const third = runtime()
  await third
    .runPromise(
      Effect.gen(function* () {
        const pages = yield* MemoryPages.Service
        expect(yield* pages.list(saved.authority.scope)).toEqual([])
        expect(Exit.isFailure(yield* pages.publish(saved.authority, saved.input).pipe(Effect.exit))).toBe(true)
      }),
    )
    .finally(() => third.dispose())
})

it.live("the additive page migration preserves existing notes and can be reopened without replay", () =>
  Effect.gen(function* () {
    const h = yield* setup
    yield* h.database.db.run("DROP TABLE memory_page_tombstone").pipe(Effect.orDie)
    yield* h.database.db.run("DROP TABLE memory_page").pipe(Effect.orDie)
    yield* h.database.db.run("DELETE FROM migration WHERE id = '20261115181429_memory-pages'").pipe(Effect.orDie)
    yield* DatabaseMigration.applyOnly(h.database.db, [migration]).pipe(Effect.orDie)
    expect(yield* h.memory.get(h.note.id)).toEqual(h.note)
    const page = yield* h.pages.publish(h.authority, h.input)
    yield* DatabaseMigration.applyOnly(h.database.db, [migration]).pipe(Effect.orDie)
    expect(yield* h.pages.get(h.authority.scope, page.id)).toEqual(page)
    expect(yield* h.memory.get(h.note.id)).toEqual(h.note)
  }),
)
