import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { LLMEvent } from "@zaovra-ai/llm"
import { eq, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Scope } from "effect"
import { Memory } from "@zaovra-ai/schema/memory"
import { Config } from "../src/config"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { MemoryStore } from "../src/memory/store"
import { MemoryTidyStore } from "../src/memory/tidy-store"
import { ModelV2 } from "../src/model"
import { Catalog } from "../src/catalog"
import { ModelMemoryProfile } from "../src/model-memory-profile"
import { MemoryWritePolicy } from "../src/memory/write-policy"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { MemoryTool } from "../src/tool/memory"
import { MemoryCheckTool } from "../src/tool/memory-check"
import { ToolRegistry } from "../src/tool/registry"
import { ReadTool } from "../src/tool/read"
import { PermissionV2 } from "../src/permission"
import { ReadReceiptTable } from "../src/read-receipt.sql"
import { EventTable } from "../src/event/sql"
import { MemoryFileEvidence } from "../src/memory/file-evidence"
import { createLLMEventPublisher } from "../src/session/runner/publish-llm-event"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { toolIdentity } from "./lib/tool"

import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { MemoryRecorder } from "../src/memory/recorder"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"

const model = { id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") }
const setup = Effect.gen(function* () {
  const sessions = yield* SessionV2.Service
  const store = yield* MemoryStore.Service
  const events = yield* EventV2.Service
  const here = yield* Location.Service
  const registry = yield* ToolRegistry.Service
  const catalog = yield* Catalog.Service
  const writing = yield* MemoryWritePolicy.Service
  const database = yield* Database.Service
  yield* catalog.transform((draft) => {
    draft.provider.update(model.providerID, (provider) => {
      provider.integrationID = undefined
    })
    draft.model.update(model.providerID, model.id, (entry) => {
      entry.enabled = true
      entry.capabilities.tools = true
      // Deliberately untrusted declaration: only the host fixture profile can allow it.
      entry.capabilities.memoryNote = true
    })
  })
  const captured = yield* registry.materialize()
  const project = yield* store.scope({ project: here.project.id, directory: here.directory })
  const create = (parentID?: SessionV2.ID) =>
    sessions.create({ parentID, model, location: { directory: here.directory } })
  const call = (
    sessionID: SessionV2.ID,
    input: Record<string, unknown>,
    name = "memory_note",
    callID: string = randomUUID(),
    author: ModelV2.Ref = model,
  ) =>
    Effect.gen(function* () {
      const context = { sessionID, assistantMessageID: SessionMessage.ID.create(), agent: toolIdentity.agent }
      const timestamp = yield* DateTime.now
      yield* events.publish(SessionEvent.Step.Started, { ...context, timestamp, model: author })
      yield* events.publish(SessionEvent.Tool.Input.Started, { ...context, timestamp, callID, name })
      const source = yield* events.publish(SessionEvent.Tool.Called, {
        ...context,
        timestamp,
        callID,
        tool: name,
        input,
        provider: { executed: false },
      })
      return {
        context,
        source,
        invocation: { ...context, call: { type: "tool-call" as const, id: callID, name, input } },
      }
    })
  const read = (sessionID: SessionV2.ID, input: { path: string; limit?: number }, providerExecuted = false) =>
    Effect.gen(function* () {
      const publisher = createLLMEventPublisher(events, {
        sessionID,
        agent: toolIdentity.agent,
        model,
        inputSequence: 0,
        contextEpoch: 0,
      })
      const event = LLMEvent.toolCall({ id: randomUUID(), name: "read", input, providerExecuted })
      yield* publisher.publish(event)
      const assistantMessageID = yield* publisher.assistantMessageID(event.id)
      const result = yield* captured.settle({ sessionID, assistantMessageID, agent: toolIdentity.agent, call: event })
      expect(result.result.type).not.toBe("error")
      yield* publisher.publish(
        LLMEvent.toolResult({ id: event.id, name: "read", result: result.result, output: result.output }),
      )
      return { callID: event.id, path: input.path }
    })
  return {
    sessions,
    store,
    events,
    captured,
    project,
    create,
    call,
    catalog,
    writing,
    database,
    read,
    directory: here.directory,
  }
})

test("main memory_note resolves its durable source and remains unverified; user edits stay authoritative", () =>
  withMemory(
    (h) =>
      Effect.gen(function* () {
        const main = yield* h.create()
        const input = { kind: "decision", text: "Keep the local fixture offline", basis: "user approved", seq: 999999 }
        const called = yield* h.call(main.id, input)
        expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({ kept: true })
        const notes = yield* h.store.list(h.project)
        expect(notes).toHaveLength(1)
        expect(notes[0]).toMatchObject({
          origin: "model",
          status: "unverified",
          sessionID: main.id,
          seq: called.source.durable?.seq,
        })
        expect(notes[0].seq).toBeGreaterThan(0)
        expect(notes[0].seq).not.toBe(999999)
        yield* h.store.edit(notes[0].id, { text: "User correction stays authoritative" })
        expect((yield* h.store.get(notes[0].id))?.text).toBe("User correction stays authoritative")
      }),
    true,
  ))

test("unknown profile refuses a catalog self-declaration without preventing search", () =>
  withMemory((h) =>
    Effect.gen(function* () {
      const session = yield* h.create()
      expect((yield* h.catalog.model.get(model.providerID, model.id))?.capabilities.memoryNote).toBeUndefined()
      expect(yield* h.writing.allowed(session.id)).toBe(false)
      const call = yield* h.call(session.id, { kind: "decision", text: "Untrusted catalog claim" })
      expect((yield* h.captured.settle(call.invocation)).output?.structured).toMatchObject({ kept: false })
      expect(yield* h.store.list(h.project)).toEqual([])
      expect(h.captured.definitions.some((item) => item.name === "memory_search")).toBe(true)
    }),
  ))

for (const change of ["disabled", "off", "tools", "provider", "model", "variant"] as const)
  test(`captured memory leaf rechecks ${change} at admission`, () =>
    withMemory(
      (h, settings) =>
        Effect.gen(function* () {
          const session = yield* h.create()
          const call = yield* h.call(session.id, { kind: "decision", text: "Only the evaluated author may write" })
          expect(yield* h.writing.allowed(session.id)).toBe(true)
          if (change === "disabled") settings.enabled = false
          if (change === "off" || change === "tools")
            yield* h.catalog.transform((draft) =>
              draft.model.update(model.providerID, model.id, (entry) => {
                if (change === "off") entry.memoryNote = "off"
                if (change === "tools") entry.capabilities.tools = false
              }),
            )
          if (change === "provider")
            yield* h.catalog.transform((draft) =>
              draft.provider.update(model.providerID, (entry) => {
                entry.disabled = true
              }),
            )
          if (change === "model")
            yield* h.sessions.switchModel({
              sessionID: session.id,
              model: { ...model, id: ModelV2.ID.make("unknown") },
            })
          if (change === "variant")
            yield* h.sessions.switchModel({
              sessionID: session.id,
              model: { ...model, variant: ModelV2.VariantID.make("other") },
            })
          expect((yield* h.captured.settle(call.invocation)).output?.structured).toMatchObject({ kept: false })
          expect(yield* h.store.list(h.project)).toEqual([])
        }),
      true,
    ))

test("switching an unknown author's session to a reliable model cannot launder its old call", () =>
  withMemory(
    (h) =>
      Effect.gen(function* () {
        const session = yield* h.create()
        const unknown = { ...model, id: ModelV2.ID.make("unknown") }
        yield* h.sessions.switchModel({ sessionID: session.id, model: unknown })
        const call = yield* h.call(
          session.id,
          { kind: "decision", text: "Original author must match" },
          "memory_note",
          randomUUID(),
          unknown,
        )
        yield* h.sessions.switchModel({ sessionID: session.id, model })
        expect(yield* h.writing.allowed(session.id)).toBe(true)
        expect((yield* h.captured.settle(call.invocation)).output?.structured).toMatchObject({ kept: false })
        expect(yield* h.store.list(h.project)).toEqual([])
      }),
    true,
  ))

test("another session's unknown model does not unregister the reliable session's memory tool", () =>
  withMemory(
    (h) =>
      Effect.gen(function* () {
        const reliable = yield* h.create()
        const unknown = yield* h.create()
        yield* h.sessions.switchModel({ sessionID: unknown.id, model: { ...model, id: ModelV2.ID.make("unknown") } })
        expect(yield* h.writing.allowed(reliable.id)).toBe(true)
        expect(yield* h.writing.allowed(unknown.id)).toBe(false)
        const call = yield* h.call(reliable.id, { kind: "decision", text: "Isolated reliable session" })
        expect((yield* h.captured.settle(call.invocation)).output?.structured).toMatchObject({ kept: true })
        expect(yield* h.store.list(h.project)).toHaveLength(1)
      }),
    true,
  ))

for (const mismatch of ["missing", "call", "assistant", "session", "tool", "input"] as const)
  test(`memory_note rejects ${mismatch} provenance without writing`, () =>
    withMemory(
      (h) =>
        Effect.gen(function* () {
          const main = yield* h.create()
          const other = yield* h.create()
          expect(yield* h.writing.allowed(main.id)).toBe(true)
          expect(yield* h.writing.allowed(other.id)).toBe(true)
          const input = { kind: "decision", text: "A durable call must own this note" }
          if (mismatch === "missing") {
            const result = yield* h.captured.settle({
              sessionID: main.id,
              ...toolIdentity,
              call: { type: "tool-call", id: randomUUID(), name: "memory_note", input },
            })
            expect(result.output?.structured).toMatchObject({
              kept: false,
              reason: expect.stringContaining("original durable tool call"),
            })
            expect(yield* h.store.list(h.project)).toEqual([])
            return
          }
          const called = yield* h.call(main.id, input, mismatch === "tool" ? "memory_search" : "memory_note")
          const invocation = {
            ...called.invocation,
            ...(mismatch === "session" ? { sessionID: other.id } : {}),
            ...(mismatch === "assistant" ? { assistantMessageID: SessionMessage.ID.create() } : {}),
            call: {
              ...called.invocation.call,
              name: "memory_note",
              ...(mismatch === "call" ? { id: randomUUID() } : {}),
              ...(mismatch === "input" ? { input: { ...input, text: "different note" } } : {}),
            },
          }
          expect((yield* h.captured.settle(invocation)).output?.structured).toMatchObject({
            kept: false,
            reason: expect.stringContaining("original durable tool call"),
          })
          expect(yield* h.store.list(h.project)).toEqual([])
        }),
      true,
    ))

test("a real child session cannot save notes but can search and return evidence to its parent", () =>
  withMemory((h) =>
    Effect.gen(function* () {
      const main = yield* h.create()
      const child = yield* h.create(main.id)
      const manual = yield* h.store.write({
        scope: h.project,
        kind: "decision",
        text: "Manual offline fixture note",
        origin: "user",
        status: "verified",
      })
      expect(manual).toBeDefined()
      const called = yield* h.call(child.id, { kind: "decision", text: "Child must suggest this to parent" })
      expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({
        kept: false,
        reason: expect.stringContaining("parent"),
      })
      const search = yield* h.captured.settle({
        ...called.context,
        call: { type: "tool-call", id: randomUUID(), name: "memory_search", input: { query: "offline fixture" } },
      })
      expect(search.result.type).not.toBe("error")
      expect(JSON.stringify(search.output?.structured)).toContain("Manual offline fixture note")
      expect(yield* h.store.list(h.project)).toHaveLength(1)
      if (!manual) throw new Error("manual fixture missing")
      expect(manual.seq).toBeUndefined()
      yield* h.store.edit(manual.id, { text: "Manual correction" })
      expect((yield* h.store.get(manual.id))?.text).toBe("Manual correction")
    }),
  ))

test("Recorder ignores child success and correlates identical call IDs by session and assistant", () =>
  withMemory((h) =>
    Effect.gen(function* () {
      const main = yield* h.create()
      const child = yield* h.create(main.id)
      const childUnique = yield* h.call(child.id, { command: "bun build" }, "bash", "child-only")
      const parentCall = yield* h.call(main.id, { command: "bun typecheck" }, "bash", "shared")
      const childCall = yield* h.call(child.id, { command: "bun test" }, "bash", "shared")
      const sameSessionCall = yield* h.call(main.id, { command: "bun lint" }, "bash", "shared")
      for (const called of [childUnique, childCall, sameSessionCall, parentCall])
        yield* h.events.publish(SessionEvent.Tool.Success, {
          ...called.context,
          timestamp: yield* DateTime.now,
          callID: called.invocation.call.id,
          provider: { executed: false },
          structured: { exit: 0, truncated: false },
          content: [],
        })
      // Success subscribers process in order. The parent typecheck is the last barrier.
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((yield* h.store.list(h.project)).some((note) => note.text === "typecheck: `bun typecheck`")) break
        yield* Effect.sleep("10 millis")
      }
      const notes = yield* h.store.list(h.project)
      expect(notes.some((note) => note.text === "typecheck: `bun typecheck`" && note.sessionID === main.id)).toBe(true)
      expect(notes.some((note) => note.sessionID === child.id || note.text.includes("bun test"))).toBe(false)
    }),
  ))

const windows = process.platform === "win32" && process.arch === "x64" ? test : test.skip

for (const content of ["original evidence", "\ufeff原始内容", ""])
  windows(`memory file source uses the real Read receipt and remains unknown: ${JSON.stringify(content)}`, () =>
    withMemory(
      (h) =>
        Effect.gen(function* () {
          const session = yield* h.create()
          const absolute = path.join(h.directory, "source.txt")
          yield* Effect.promise(() => writeFile(absolute, content))
          const file = yield* h.read(session.id, { path: "source.txt" })
          // No path lookup is needed to consume the historical read. Deleting it must
          // not falsely turn the historical receipt into a current/missing verdict.
          yield* Effect.promise(() => unlink(absolute))
          const called = yield* h.call(session.id, {
            kind: "decision",
            text: "Retain the reason behind this choice",
            file,
            digest: "forged",
            verified: true,
          })
          expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({ kept: true })
          const notes = yield* h.store.list(h.project)
          expect(notes).toHaveLength(1)
          expect(notes[0]).toMatchObject({ origin: "model", status: "unverified", fileRevision: 1 })
          expect(MemoryFileEvidence.state(notes[0]!)).toBe("unknown")
          expect(notes[0]!.files).toMatchObject({
            version: 1,
            state: "unknown",
            files: [
              {
                path: "source.txt",
                directory: h.directory,
                sessionID: session.id,
                digest: createHash("sha256").update(Buffer.from(content)).digest("hex"),
                bytes: Buffer.byteLength(content),
              },
            ],
          })
          const receipt = yield* h.database.db
            .select()
            .from(ReadReceiptTable)
            .where(eq(ReadReceiptTable.call_id, file.callID))
            .get()
          expect(notes[0]!.files).toMatchObject({ files: [{ seq: receipt!.success_seq }] })
          expect(notes[0]!.seq).toBeGreaterThan(receipt!.success_seq)
          expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({ kept: true })
          expect(yield* h.store.list(h.project)).toEqual(notes)
          yield* h.store.remove(notes[0]!.id)
          expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({ kept: false })
          expect(yield* h.store.list(h.project)).toEqual([])
        }),
      true,
    ),
  )

for (const mode of [
  "cross-session",
  "child",
  "partial",
  "provider",
  "external",
  "missing",
  "path",
  "late",
  "workspace",
  "project",
  "directory",
  "event",
  "digest",
  "selection",
  "ambiguous",
  "event-provider",
  "event-author",
  "event-tool",
  "event-text",
] as const)
  windows(`memory file source rejects ${mode} without leaving a note`, () =>
    withMemory(
      (h) =>
        Effect.gen(function* () {
          const parent = yield* h.create()
          const session = mode === "child" ? yield* h.create(parent.id) : parent
          const absolute = path.join(h.directory, "source.txt")
          const external = path.join(path.dirname(h.directory), path.basename(h.directory) + "-outside.txt")
          yield* Effect.promise(() => writeFile(mode === "external" ? external : absolute, "original evidence"))
          const file = yield* h.read(
            session.id,
            { path: mode === "external" ? external : "source.txt", ...(mode === "partial" ? { limit: 1 } : {}) },
            mode === "provider",
          )
          if (mode === "external") yield* Effect.promise(() => unlink(external))
          const target = mode === "cross-session" ? yield* h.create() : session
          const input = {
            kind: "decision",
            text: "Evidence cannot grant itself authority",
            file: { ...file, ...(mode === "path" ? { path: "another.txt" } : {}) },
          }
          const called = yield* h.call(target.id, input)
          if (mode === "missing")
            yield* h.database.db.delete(ReadReceiptTable).where(eq(ReadReceiptTable.call_id, file.callID)).run()
          if (mode === "late")
            yield* h.database.db
              .update(ReadReceiptTable)
              .set({ success_seq: called.source.durable!.seq })
              .where(eq(ReadReceiptTable.call_id, file.callID))
              .run()
          if (mode === "workspace")
            yield* h.database.db
              .update(ReadReceiptTable)
              .set({ workspace_id: "foreign" })
              .where(eq(ReadReceiptTable.call_id, file.callID))
              .run()
          if (mode === "project")
            yield* h.database.db
              .update(ReadReceiptTable)
              .set({ project_id: "foreign" })
              .where(eq(ReadReceiptTable.call_id, file.callID))
              .run()
          if (mode === "directory")
            yield* h.database.db
              .update(ReadReceiptTable)
              .set({ directory: "foreign" })
              .where(eq(ReadReceiptTable.call_id, file.callID))
              .run()
          if (mode === "digest")
            yield* h.database.db
              .update(ReadReceiptTable)
              .set({ digest: "0".repeat(64) })
              .where(eq(ReadReceiptTable.call_id, file.callID))
              .run()
          if (mode === "event") {
            const receipt = yield* h.database.db
              .select()
              .from(ReadReceiptTable)
              .where(eq(ReadReceiptTable.call_id, file.callID))
              .get()
            yield* h.database.db
              .delete(EventTable)
              .where(sql`${EventTable.aggregate_id} = ${session.id} AND ${EventTable.seq} = ${receipt!.success_seq}`)
              .run()
          }
          if (mode === "ambiguous") {
            const receipt = yield* h.database.db
              .select()
              .from(ReadReceiptTable)
              .where(eq(ReadReceiptTable.call_id, file.callID))
              .get()
            yield* h.database.db
              .insert(ReadReceiptTable)
              .values({ ...receipt!, id: randomUUID(), assistant_message_id: "another-assistant" })
              .run()
          }
          if (mode === "event-provider" || mode === "event-author" || mode === "event-tool" || mode === "event-text") {
            const receipt = yield* h.database.db
              .select()
              .from(ReadReceiptTable)
              .where(eq(ReadReceiptTable.call_id, file.callID))
              .get()
            const key =
              mode === "event-tool"
                ? "$.tool"
                : mode === "event-author"
                  ? "$.assistantMessageID"
                  : mode === "event-provider"
                    ? "$.provider.executed"
                    : "$.structured.content"
            const value = mode === "event-provider" ? 1 : "substituted"
            yield* h.database.db
              .update(EventTable)
              .set({ data: sql`json_set(${EventTable.data}, ${key}, ${value})` })
              .where(
                sql`${EventTable.aggregate_id} = ${session.id} AND ${EventTable.seq} = ${mode === "event-tool" ? receipt!.called_seq : receipt!.success_seq}`,
              )
              .run()
          }
          const invocation =
            mode === "selection"
              ? {
                  ...called.invocation,
                  call: { ...called.invocation.call, input: { ...input, file: { ...file, callID: "substituted" } } },
                }
              : called.invocation
          expect((yield* h.captured.settle(invocation)).output?.structured).toMatchObject({ kept: false })
          expect(yield* h.store.list(h.project)).toEqual([])
        }),
      true,
    ),
  )

windows("a real Read does not grant an unknown model memory writing", () =>
  withMemory((h) =>
    Effect.gen(function* () {
      const session = yield* h.create()
      yield* Effect.promise(() => writeFile(path.join(h.directory, "source.txt"), "real file"))
      const file = yield* h.read(session.id, { path: "source.txt" })
      const called = yield* h.call(session.id, { kind: "decision", text: "No evaluated profile", file })
      expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({ kept: false })
      expect(yield* h.store.list(h.project)).toEqual([])
    }),
  ),
)

for (const origin of ["model", "user"] as const)
  windows(`file association never backfills an existing ${origin} note`, () =>
    withMemory(
      (h) =>
        Effect.gen(function* () {
          const session = yield* h.create()
          const text = "Keep the existing note unchanged"
          const existing = yield* h.store.write({
            scope: h.project,
            kind: "decision",
            text,
            origin,
            status: origin === "user" ? "verified" : "unverified",
          })
          yield* Effect.promise(() => writeFile(path.join(h.directory, "source.txt"), "real file"))
          const file = yield* h.read(session.id, { path: "source.txt" })
          const called = yield* h.call(session.id, { kind: "decision", text, file })
          expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({ kept: false })
          expect(yield* h.store.get(existing!.id)).toEqual(existing)
        }),
      true,
    ),
  )

windows("file binding insert failure leaves neither an unlinked note nor a partial binding", () =>
  withMemory(
    (h) =>
      Effect.gen(function* () {
        const session = yield* h.create()
        yield* Effect.promise(() => writeFile(path.join(h.directory, "source.txt"), "real file"))
        const file = yield* h.read(session.id, { path: "source.txt" })
        const called = yield* h.call(session.id, { kind: "decision", text: "Atomic storage failure", file })
        yield* h.database.db.run(
          sql`CREATE TRIGGER reject_file_note BEFORE INSERT ON memory_note WHEN NEW.files IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture file binding rejection'); END`,
        )
        const result = yield* h.captured.settle(called.invocation).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect(yield* h.store.list(h.project)).toEqual([])
      }),
    true,
  ),
)

windows("a published Read receipt binds a note that can be rechecked without minting another receipt", () =>
  withMemory(
    (h) =>
      Effect.gen(function* () {
        const session = yield* h.create()
        const source = path.join(h.directory, "source.txt")
        yield* Effect.promise(() => writeFile(source, Buffer.from([0xef, 0xbb, 0xbf, 97])))
        const file = yield* h.read(session.id, { path: "source.txt" })
        const called = yield* h.call(session.id, { kind: "decision", text: "Real source recheck integration", file })
        expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({ kept: true })
        const note = (yield* h.store.list(h.project))[0]!
        expect(note.files).toMatchObject({ state: "unknown" })
        expect(note.status).toBe("unverified")
        const first = yield* h.call(
          session.id,
          { noteID: note.id, expectedRevision: note.fileRevision },
          "memory_check",
        )
        expect((yield* h.captured.settle(first.invocation)).output?.structured).toMatchObject({
          outcome: "matched-at-check",
          applied: true,
          checkedFiles: 1,
        })
        const matched = (yield* h.store.get(note.id))!
        expect(matched.files).toMatchObject({ state: "unknown" })
        expect(matched.status).toBe("unverified")
        yield* Effect.promise(() => writeFile(source, "changed after the check"))
        const second = yield* h.call(
          session.id,
          { noteID: note.id, expectedRevision: matched.fileRevision },
          "memory_check",
        )
        expect((yield* h.captured.settle(second.invocation)).output?.structured).toMatchObject({
          outcome: "changed",
          applied: true,
          checkedFiles: 1,
        })
        expect((yield* h.store.get(note.id))!.status).toBe("stale")
        expect((yield* h.store.get(note.id))!.text).toBe(note.text)
        const receipts = yield* h.database.db.select().from(ReadReceiptTable).all()
        expect(receipts).toHaveLength(1)
        expect(receipts[0]!.call_id).toBe(file.callID)
      }),
    true,
  ),
)

async function withMemory(
  body: (h: Effect.Success<typeof setup>, settings: { enabled: boolean }) => Effect.Effect<void, unknown, Scope.Scope>,
  evaluated = false,
) {
  await using tmp = await tmpdir()
  const settings = { enabled: true }
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* body(yield* setup, settings)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            Catalog.node,
            MemoryWritePolicy.node,
            MemoryTool.node,
            MemoryCheckTool.node,
            ReadTool.node,
            MemoryRecorder.node,
            Database.node,
            EventV2.node,
            MemoryStore.node,
            MemoryTidyStore.node,
            SessionV2.node,
            Location.node,
            ToolRegistry.node,
          ]),
          [
            [
              PermissionV2.node,
              Layer.succeed(
                PermissionV2.Service,
                PermissionV2.Service.of({
                  assert: () => Effect.void,
                  ask: () => Effect.die("unused"),
                  reply: () => Effect.die("unused"),
                  get: () => Effect.die("unused"),
                  forSession: () => Effect.die("unused"),
                  list: () => Effect.die("unused"),
                }),
              ),
            ],
            [
              ModelMemoryProfile.node,
              Layer.succeed(
                ModelMemoryProfile.Service,
                ModelMemoryProfile.Service.of({
                  memoryNote: (entry, variant) =>
                    evaluated && entry.providerID === model.providerID && entry.id === model.id && variant === undefined
                      ? true
                      : undefined,
                }),
              ),
            ],
            [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
            [
              Global.node,
              Global.layerWith({
                data: path.join(tmp.path, "data"),
                config: path.join(tmp.path, "config"),
                state: path.join(tmp.path, "state"),
              }),
            ],
            [SessionExecution.node, SessionExecution.noopLayer],
            [
              Config.node,
              Layer.succeed(
                Config.Service,
                Config.Service.of({
                  entries: () =>
                    Effect.sync(() => [
                      new Config.Document({
                        type: "document",
                        info: new Config.Info({ memory: { enabled: settings.enabled } }),
                      }),
                    ]),
                }),
              ),
            ],
          ],
        ),
      ),
      Effect.scoped,
    ),
  )
}
