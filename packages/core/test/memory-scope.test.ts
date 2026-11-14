import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { MemoryStore } from "@zaovra-ai/core/memory/store"
import { MemoryNoteTable } from "@zaovra-ai/core/memory/sql"
import { Project } from "@zaovra-ai/core/project"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionSchema } from "@zaovra-ai/core/session/schema"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@zaovra-ai/core/session/sql"
import { Hash } from "@zaovra-ai/core/util/hash"
import { Memory } from "@zaovra-ai/schema/memory"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, MemoryStore.node])))
const content = { kind: "practice" as const, origin: "model" as const, status: "verified" as const }

test("POSIX directory identity preserves case and backslashes in a new namespace", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const scopes = ["/workspace/Alpha", "/workspace/alpha", "/workspace/a\\b", "/workspace/a/b"].map((directory) =>
      MemoryStore.scope({ project: Project.ID.global, directory }, platform),
    )
    expect(new Set(scopes).size).toBe(4)
    expect(scopes.every((scope) => scope.startsWith("dir_posix_v2_"))).toBe(true)
    expect(scopes[1]).toBe(MemoryStore.scope({ project: Project.ID.global, directory: "/workspace/alpha" }, platform))
    expect(scopes[1]).not.toBe(`dir_${Hash.fast("/workspace/alpha").slice(0, 24)}`)
    expect(scopes).not.toContain(Memory.Scope.user)
  }
})

test("Windows keeps legacy keys; repository identity is independent of platform and directory", () => {
  for (const directory of ["C:\\Users\\Me\\Notes", "c:/users/me/notes", "\\\\Server\\Share\\Notes"]) {
    expect(MemoryStore.scope({ project: Project.ID.global, directory }, "win32")).toBe(
      Memory.Scope.make(`dir_${Hash.fast(directory.replaceAll("\\", "/").toLowerCase()).slice(0, 24)}`),
    )
  }
  for (const platform of ["win32", "linux", "darwin"] as const) {
    expect(MemoryStore.scope({ project: Project.ID.make("repository"), directory: "/Alpha" }, platform)).toBe(
      Memory.Scope.make("repository"),
    )
    expect(MemoryStore.scope({ project: Project.ID.make("repository"), directory: "/alpha" }, platform)).toBe(
      Memory.Scope.make("repository"),
    )
  }
  const place = { project: Project.ID.global, directory: "/workspace/Alpha" }
  expect(MemoryStore.scope(place)).toBe(MemoryStore.scope(place, process.platform))
})

for (const directories of [
  ["/workspace/Alpha", "/workspace/alpha"],
  ["/workspace/a\\b", "/workspace/a/b"],
]) {
  // The real database codec deliberately converts backslashes on Windows. A POSIX
  // literal-backslash conversation must run on a POSIX host, not through that codec.
  const run =
    process.platform === "win32" && directories.some((directory) => directory.includes("\\")) ? it.live.skip : it.live
  run(`POSIX notes, conversation search and deletion stay isolated: ${directories.join(" / ")}`, () =>
    isolation(directories, "linux"),
  )
}

it.live("new POSIX scopes neither read nor mutate legacy notes and tombstones", () =>
  Effect.gen(function* () {
    const store = yield* MemoryStore.Service
    const database = yield* Database.Service
    const old = Memory.Scope.make(`dir_${Hash.fast("/workspace/alpha").slice(0, 24)}`)
    yield* store.write({ ...content, scope: old, text: "legacy living evidence" })
    const erased = (yield* store.write({ ...content, scope: old, text: "legacy erased evidence" }))!
    yield* store.remove(erased.id)
    const before = yield* database.db
      .select()
      .from(MemoryNoteTable)
      .where(eq(MemoryNoteTable.scope, old))
      .all()
      .pipe(Effect.orDie)
    expect(before.some((row) => row.time_deleted !== null)).toBe(true)
    for (const directory of ["/workspace/Alpha", "/workspace/alpha"]) {
      const scope = MemoryStore.scope({ project: Project.ID.global, directory }, "linux")
      expect(yield* store.list(scope)).toEqual([])
      expect((yield* store.search({ scope, query: "legacy" })).notes).toEqual([])
      // Old suppression cannot be attributed to either new scope. No migration is implied.
      expect(yield* store.write({ ...content, scope, text: "legacy erased evidence" })).toBeDefined()
      yield* store.clear(scope)
    }
    expect(
      yield* database.db.select().from(MemoryNoteTable).where(eq(MemoryNoteTable.scope, old)).all().pipe(Effect.orDie),
    ).toEqual(before)
  }),
)

const linux = process.platform === "linux" ? it.live : it.live.skip
linux("Linux real non-repository directories retain distinct case and literal backslash identities", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), "memory-scope-"))),
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    )
    const directories = ["Alpha", "alpha", "a\\b", "a/b"].map((name) => path.join(root, name))
    yield* Effect.promise(() => Promise.all(directories.map((directory) => mkdir(directory, { recursive: true }))))
    const identities = yield* Effect.promise(() => Promise.all(directories.map((directory) => stat(directory))))
    expect(new Set(identities.map((info) => `${info.dev}:${info.ino}`)).size).toBe(4)
    yield* isolation(directories.slice(0, 2))
    yield* isolation(directories.slice(2))
  }),
)

function isolation(directories: string[], platform: NodeJS.Platform = process.platform) {
  return Effect.gen(function* () {
    const store = yield* MemoryStore.Service
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directories[0]), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const places = directories.map((directory) => ({ project: Project.ID.global, directory }))
    const scopes = places.map((place) => MemoryStore.scope(place, platform))
    const sessions = directories.map((directory) => SessionSchema.ID.make(`ses_scope_${Hash.fast(directory)}`))
    yield* database.db
      .insert(SessionTable)
      .values(
        places.map((place, index) => ({
          id: sessions[index],
          project_id: place.project,
          directory: place.directory,
          slug: sessions[index],
          title: "scope evidence",
          version: "test",
          agent: "test",
        })),
      )
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionMessageTable)
      .values(
        sessions.map((session_id) => ({
          id: SessionMessage.ID.make(`msg_${session_id}`),
          session_id,
          type: "user" as const,
          seq: 1,
          time_created: 1,
          data: { text: "scope evidence", time: { created: 1 } },
        })),
      )
      .run()
      .pipe(Effect.orDie)
    const left = (yield* store.write({ ...content, scope: scopes[0], text: "scope evidence", sessionID: sessions[0] }))!
    const right = (yield* store.write({
      ...content,
      scope: scopes[1],
      text: "scope evidence",
      sessionID: sessions[1],
    }))!
    expect(right).toBeDefined()
    expect(left.id).not.toBe(right.id)
    for (const index of [0, 1]) {
      const found = yield* store.search({ scope: scopes[index], place: places[index], query: "scope evidence" })
      expect(found.notes.map((note) => note.id)).toEqual([index === 0 ? left.id : right.id])
      expect(found.sessions.map((session) => session.sessionID)).toEqual([sessions[index]])
    }
    yield* store.remove(left.id)
    expect(yield* store.list(scopes[0])).toEqual([])
    expect((yield* store.list(scopes[1])).map((note) => note.id)).toEqual([right.id])
    expect(yield* store.write({ ...content, scope: scopes[0], text: "scope evidence" })).toBeUndefined()
    yield* store.clear(scopes[0])
    expect((yield* store.get(right.id))?.text).toBe("scope evidence")
    expect(
      (yield* store.search({ scope: scopes[0], place: places[0], query: "scope evidence" })).sessions.map(
        (session) => session.sessionID,
      ),
    ).toEqual([sessions[0]])
    expect(
      (yield* store.search({ scope: scopes[1], place: places[1], query: "scope evidence" })).sessions.map(
        (session) => session.sessionID,
      ),
    ).toEqual([sessions[1]])
    // A deletion in the first scope must not suppress future observations in the second.
    yield* store
      .write({ ...content, scope: scopes[0], text: "scope later evidence" })
      .pipe(Effect.flatMap((note) => store.remove(note!.id)))
    expect(
      yield* store.observe({
        scope: scopes[1],
        kind: "practice",
        key: "scope-later",
        text: "scope later evidence",
        verification: "test",
        sessionID: sessions[1],
        settled: true,
      }),
    ).toBeDefined()
  })
}
