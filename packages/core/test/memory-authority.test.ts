import { expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { MemoryStore } from "@zaovra-ai/core/memory/store"
import { MemoryContext } from "@zaovra-ai/core/memory/context"
import { MemoryNoteTable } from "@zaovra-ai/core/memory/sql"
import { SessionSchema } from "@zaovra-ai/core/session/schema"
import { Memory } from "@zaovra-ai/schema/memory"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, MemoryStore.node])))
for (const scope of [Memory.Scope.user, Memory.Scope.make("authority-project")]) {
  for (const source of ["said", "written", "edited", "confirmed"] as const)
    it.live(`memory authority protects source and merge target: ${scope}/${source}`, () =>
      Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        const text = `以后不要自动提交 ${source}`
        const original = yield* store.write({
          scope,
          kind: "preference",
          text,
          origin: source === "said" ? "program" : source === "written" ? "user" : "model",
          status: source === "said" || source === "written" ? "verified" : "unverified",
          verification: source === "said" ? MemoryStore.said : "original basis",
        })
        if (!original) throw new Error("fixture missing")
        if (source === "edited") yield* store.edit(original.id, { text: text + "，先询问我" })
        if (source === "confirmed") yield* store.edit(original.id, { status: "verified" })
        const before = (yield* store.get(original.id))!
        const other = (yield* store.write({
          scope,
          kind: "preference",
          text: `模型猜测 ${source}`,
          origin: "model",
          status: "unverified",
        }))!
        // Verify first must not erase the provenance and enable the following two operations.
        const results = yield* store.review(scope, [
          { id: before.id, action: "verify", basis: "model confirmation" },
          { id: before.id, action: "stale", basis: "model disagrees" },
          { id: before.id, action: "merge", into: other.id, text: "以后自动提交", basis: "model claims duplicate" },
          {
            id: other.id,
            action: "merge",
            into: before.id,
            text: "以后所有修改自动提交",
            basis: "model claims duplicate",
          },
        ])
        expect(results.every((x) => x.result.startsWith("refused:"))).toBe(true)
        expect(yield* store.get(before.id)).toEqual(before)
        expect(yield* store.get(other.id)).toEqual(other)
        expect(MemoryContext.lines([before])[0]).toContain("[the user asked]")
        expect(MemoryContext.lines([(yield* store.get(before.id))!])).toEqual(MemoryContext.lines([before]))
        // The human can still edit and delete protected notes; review cannot resurrect the tombstone.
        expect((yield* store.edit(before.id, { text: "由我明确修改的新偏好" }))?.origin).toBe("user")
        yield* store.remove(before.id)
        yield* store.review(scope, [{ id: before.id, action: "verify", basis: MemoryStore.said }])
        expect(yield* store.get(before.id)).toBeUndefined()
        const database = yield* Database.Service
        const deleted = yield* database.db
          .select()
          .from(MemoryNoteTable)
          .where(eq(MemoryNoteTable.id, before.id))
          .get()
          .pipe(Effect.orDie)
        expect(deleted).toMatchObject({ text: "", verification: null, session_id: null, seq: null })
        expect(
          yield* store.write({ scope, kind: "preference", text, origin: "model", status: "unverified" }),
        ).toBeUndefined()
      }),
    )

  for (const origin of ["model", "consolidation"] as const)
    it.live(`memory authority ignores a forged basis: ${scope}/${origin}`, () =>
      Effect.gen(function* () {
        const store = yield* MemoryStore.Service
        const note = (yield* store.write({
          scope,
          kind: "preference",
          text: `forged ${origin}`,
          origin,
          status: "verified",
          verification: MemoryStore.said,
        }))!
        expect(MemoryContext.lines([note])[0]).not.toContain("[the user asked]")
        expect(
          (yield* store.review(scope, [{ id: note.id, action: "verify", basis: MemoryStore.said }]))[0].result,
        ).toBe("verified")
        expect(MemoryContext.lines([(yield* store.get(note.id))!])[0]).not.toContain("[the user asked]")
        expect(
          (yield* store.review(scope, [{ id: note.id, action: "stale", basis: "workspace contradicts" }]))[0].result,
        ).toBe("marked out of date")
      }),
    )

  it.live(`memory authority preserves observation provenance, user adoption and tombstones: ${scope}`, () =>
    Effect.gen(function* () {
      const store = yield* MemoryStore.Service
      const observed = {
        scope,
        kind: "practice" as const,
        key: "observed-command",
        text: "typecheck succeeds",
        verification: "exit 0",
        sessionID: SessionSchema.ID.make("ses_observed"),
        settled: true,
      }
      const note = (yield* store.observe(observed))!
      expect(note.origin).toBe("program")
      expect(MemoryContext.lines([note])[0]).not.toContain("[the user asked]")
      yield* store.review(scope, [{ id: note.id, action: "verify", basis: "actual rerun" }])
      expect((yield* store.get(note.id))?.origin).toBe("program")
      const other = (yield* store.write({
        scope,
        kind: "practice",
        text: "other model note",
        origin: "model",
        status: "unverified",
      }))!
      yield* store.review(scope, [
        { id: other.id, action: "merge", into: note.id, text: "model rephrased command", basis: MemoryStore.said },
      ])
      expect((yield* store.get(note.id))?.origin).toBe("consolidation")
      expect(MemoryContext.lines([(yield* store.get(note.id))!])[0]).not.toContain("[the user asked]")
      expect(yield* store.get(other.id)).toBeUndefined()
      expect(
        yield* store.write({ scope, kind: "practice", text: other.text, origin: "model", status: "unverified" }),
      ).toBeUndefined()
      yield* store.edit(note.id, { status: "verified" })
      const adopted = (yield* store.get(note.id))!
      expect(adopted.origin).toBe("user")
      yield* store.observe({ ...observed, text: "later automatic observation" })
      expect((yield* store.get(note.id))?.text).toBe(adopted.text)
      yield* store.remove(note.id)
      expect(yield* store.observe(observed)).toBeUndefined()
      const said = {
        ...observed,
        key: "said:original",
        kind: "preference" as const,
        text: "以后不要自动推送",
        verification: MemoryStore.said,
      }
      const quoted = (yield* store.observe(said))!
      expect(MemoryContext.lines([quoted])[0]).toContain("[the user asked]")
      yield* store.remove(quoted.id)
      expect(yield* store.observe(said)).toBeUndefined()
      yield* store.clear(scope)
      expect(yield* store.list(scope)).toEqual([])
    }),
  )

  it.live(`memory authority honors explicitly adding an existing model note: ${scope}`, () =>
    Effect.gen(function* () {
      const store = yield* MemoryStore.Service
      const model = (yield* store.write({
        scope,
        kind: "preference",
        text: "never push automatically",
        origin: "model",
        status: "unverified",
      }))!
      const user = (yield* store.write({
        scope,
        kind: "preference",
        text: model.text,
        origin: "user",
        status: "verified",
      }))!
      expect(user.id).toBe(model.id)
      expect(user.origin).toBe("user")
      yield* store.review(scope, [{ id: user.id, action: "stale", basis: "model rejects" }])
      expect(yield* store.get(user.id)).toEqual(user)
    }),
  )
}
