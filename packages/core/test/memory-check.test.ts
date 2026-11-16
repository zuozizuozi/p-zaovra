import { expect, test } from "bun:test"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { link, open, rename, symlink, unlink, writeFile } from "node:fs/promises"
import { eq, sql } from "drizzle-orm"
import { Cause, DateTime, Deferred, Effect, Fiber, Layer, Scope } from "effect"
import { Memory } from "@zaovra-ai/schema/memory"
import { AgentV2 } from "../src/agent"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { MemoryStore } from "../src/memory/store"
import { MemoryNoteTable, MemoryRecoveryTable } from "../src/memory/sql"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { PermissionV2 } from "../src/permission"
import { ReadPin } from "../src/read-pin"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"
import { SessionTable } from "../src/session/sql"
import { MemoryCheckTool } from "../src/tool/memory-check"
import { MemoryTool } from "../src/tool/memory"
import { ToolRegistry } from "../src/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { toolIdentity } from "./lib/tool"

const windows = process.platform === "win32" && process.arch === "x64" ? test : test.skip
const model = { id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") }
const setup = Effect.gen(function* () {
  const store = yield* MemoryStore.Service
  const sessions = yield* SessionV2.Service
  const events = yield* EventV2.Service
  const here = yield* Location.Service
  const database = yield* Database.Service
  const permission = yield* PermissionV2.Service
  const agents = yield* AgentV2.Service
  const registry = yield* ToolRegistry.Service
  const captured = yield* registry.materialize()
  const scope = yield* store.scope({ project: here.project.id, directory: here.directory })
  const session = yield* sessions.create({ model, location: { directory: here.directory } })
  const rules = (effect: "ask" | "allow" | "deny") =>
    agents.transform((editor) =>
      editor.update(toolIdentity.agent, (agent) => {
        agent.permissions = [
          { action: "*", resource: "*", effect: "allow" },
          { action: "read", resource: "*", effect },
        ]
      }),
    )
  yield* rules("allow")
  const seed = (names = ["source.txt"], origin: Memory.Origin = "user", content?: Buffer) =>
    Effect.gen(function* () {
      // Host storage fixture with actual native object identity and raw bytes; not a claimed Tool.Success receipt.
      const files = yield* Effect.forEach(names, (name) =>
        Effect.gen(function* () {
          const bytes = content ?? Buffer.from(`original:${name}`)
          yield* Effect.promise(() => writeFile(path.join(here.directory, name), bytes))
          const pin = yield* ReadPin.acquire(path.join(here.directory, name))
          if (!pin) throw new Error("native fixture unavailable")
          return {
            path: name,
            directory: here.directory,
            identity: JSON.stringify(["windows-file-id", pin.identity.volume, pin.identity.file]),
            digest: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
            sessionID: session.id,
            seq: 1,
          }
        }).pipe(Effect.scoped),
      )
      const note = (yield* store.write({
        scope,
        origin,
        kind: "practice",
        status: "verified",
        text: "native check fixture " + randomUUID(),
      }))!
      yield* store.bindFiles({ id: note.id, scope, expectedRevision: 0, files })
      return (yield* store.get(note.id))!
    })
  const call = (input: Record<string, unknown>, sessionID = session.id) =>
    Effect.gen(function* () {
      const context = { sessionID, assistantMessageID: SessionMessage.ID.create(), agent: toolIdentity.agent }
      const timestamp = yield* DateTime.now
      const callID = randomUUID()
      yield* events.publish(SessionEvent.Step.Started, { ...context, timestamp, model })
      yield* events.publish(SessionEvent.Tool.Input.Started, { ...context, timestamp, callID, name: "memory_check" })
      const source = yield* events.publish(SessionEvent.Tool.Called, {
        ...context,
        timestamp,
        callID,
        tool: "memory_check",
        input,
        provider: { executed: false },
      })
      return {
        source,
        context,
        invocation: { ...context, call: { type: "tool-call" as const, id: callID, name: "memory_check", input } },
      }
    })
  const start = (called: Effect.Success<ReturnType<typeof call>>) =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* captured.settle(called.invocation).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked).pipe(Effect.timeout("5 seconds"))
      expect(request.action).toBe("read")
      expect(request.source).toEqual({
        type: "tool",
        messageID: called.context.assistantMessageID,
        callID: called.invocation.call.id,
      })
      return { fiber, request }
    })
  return {
    store,
    sessions,
    events,
    database,
    permission,
    captured,
    scope,
    session,
    seed,
    call,
    rules,
    start,
    directory: here.directory,
  }
})
const selection = (note: Memory.Note) => ({ noteID: note.id, expectedRevision: note.fileRevision! })

windows(
  "host-bound exact bytes match only at this check, persist unknown, expose selection and reject stale retry",
  () =>
    withCheck((h) =>
      Effect.gen(function* () {
        const note = yield* h.seed()
        const called = yield* h.call(selection(note))
        const result = yield* h.captured.settle(called.invocation)
        expect(result.output?.structured).toMatchObject({ outcome: "matched-at-check", applied: true, checkedFiles: 1 })
        const after = (yield* h.store.get(note.id))!
        expect(after.files).toMatchObject({ state: "unknown" })
        expect([after.origin, after.text, after.status]).toEqual([note.origin, note.text, note.status])
        expect(after.fileRevision).toBe(note.fileRevision! + 1)
        expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({
          outcome: "unknown",
          applied: false,
        })
        const search = yield* h.captured.settle({
          ...called.context,
          call: {
            type: "tool-call",
            id: randomUUID(),
            name: "memory_search",
            input: { query: "native check fixture" },
          },
        })
        expect(search.output?.structured).toMatchObject({
          notes: expect.arrayContaining([
            expect.objectContaining({ id: note.id, fileRevision: after.fileRevision, layer: "project" }),
          ]),
        })
        yield* Effect.promise(() => writeFile(path.join(h.directory, "source.txt"), "locks released"))
      }),
    ),
)

for (const difference of ["bytes", "identity"] as const)
  for (const origin of ["user", "model"] as const)
    windows(`${difference} evidence becomes changed without rewriting ${origin} wording`, () =>
      withCheck((h) =>
        Effect.gen(function* () {
          const note = yield* h.seed(undefined, origin)
          if (difference === "identity") {
            yield* Effect.promise(() => rename(path.join(h.directory, "source.txt"), path.join(h.directory, "old.txt")))
            yield* Effect.promise(() => writeFile(path.join(h.directory, "source.txt"), "original:source.txt"))
          }
          if (difference === "bytes")
            yield* Effect.promise(() => writeFile(path.join(h.directory, "source.txt"), "changed"))
          const called = yield* h.call(selection(note))
          expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({
            outcome: "changed",
            applied: true,
          })
          const after = (yield* h.store.get(note.id))!
          expect(after.files).toMatchObject({ state: "changed" })
          expect(after.text).toBe(note.text)
          expect(after.origin).toBe(origin)
          expect(after.status).toBe(origin === "user" ? "verified" : "stale")
        }),
      ),
    )

windows("real Read denial fails the tool and preserves stored evidence", () =>
  withCheck((h) =>
    Effect.gen(function* () {
      const note = yield* h.seed()
      yield* h.rules("deny")
      const called = yield* h.call(selection(note))
      expect((yield* h.captured.settle(called.invocation)).result.type).toBe("error")
      expect(yield* h.store.get(note.id)).toEqual(note)
    }),
  ),
)

windows("permission waits hold no stable lock; replacement gets unknown without reading the replacement", () =>
  withCheck((h) =>
    Effect.gen(function* () {
      const note = yield* h.seed(["source.txt", "second.txt"])
      yield* h.rules("ask")
      const called = yield* h.call(selection(note))
      const pending = yield* h.start(called)
      expect(pending.request.resources).toEqual(["source.txt", "second.txt"])
      yield* Effect.promise(() => writeFile(path.join(h.directory, "source.txt"), "edited during approval"))
      yield* Effect.promise(() => rename(path.join(h.directory, "second.txt"), path.join(h.directory, "old.txt")))
      yield* Effect.promise(() => writeFile(path.join(h.directory, "second.txt"), "replacement not authorized"))
      yield* h.permission.reply({ requestID: pending.request.id, reply: "once" })
      const result = yield* Fiber.join(pending.fiber)
      expect(result.output?.structured).toMatchObject({ outcome: "changed", checkedFiles: 1 })
      yield* Effect.promise(() => writeFile(path.join(h.directory, "second.txt"), "released"))
    }),
  ),
)

for (const action of ["reject", "cancel"] as const)
  windows(`${action} during actual permission wait preserves memory and releases ordinary pins`, () =>
    withCheck((h) =>
      Effect.gen(function* () {
        const note = yield* h.seed()
        yield* h.rules("ask")
        const pending = yield* h.start(yield* h.call(selection(note)))
        if (action === "reject") {
          yield* h.permission.reply({ requestID: pending.request.id, reply: "reject" })
          const exit = yield* Fiber.await(pending.fiber)
          expect(exit._tag).toBe("Failure")
          if (exit._tag === "Failure")
            expect(
              exit.cause.reasons.some(
                (reason) => Cause.isDieReason(reason) && reason.defect instanceof PermissionV2.DeclinedError,
              ),
            ).toBe(true)
        }
        if (action === "cancel") yield* Fiber.interrupt(pending.fiber)
        expect(yield* h.store.get(note.id)).toEqual(note)
        expect(yield* h.permission.forSession(h.session.id)).toEqual([])
        yield* Effect.promise(() =>
          rename(path.join(h.directory, "source.txt"), path.join(h.directory, "released.txt")),
        )
      }),
    ),
  )

for (const change of ["edit", "delete", "silent", "disabled", "freeze"] as const)
  windows(`${change} during approval prevents content checking and stale writeback`, () =>
    withCheck((h, settings) =>
      Effect.gen(function* () {
        const note = yield* h.seed()
        yield* h.rules("ask")
        const pending = yield* h.start(yield* h.call(selection(note)))
        if (change === "edit") yield* h.store.edit(note.id, { text: "concurrent user edit" })
        if (change === "delete") yield* h.store.remove(note.id)
        if (change === "silent") yield* h.store.silence(h.scope, true)
        if (change === "disabled") settings.enabled = false
        if (change === "freeze") {
          const old = Memory.Scope.make("frozen-legacy")
          yield* h.database.db
            .insert(MemoryRecoveryTable)
            .values({ scope: h.scope, legacy_scope: old, directory: h.directory, state: "blank" })
            .run()
            .pipe(Effect.orDie)
          yield* h.database.db
            .insert(MemoryNoteTable)
            .values({
              id: Memory.ID.make("mem_frozen_tombstone"),
              scope: old,
              key: "opaque",
              text: "",
              kind: "practice",
              origin: "model",
              status: "stale",
              time_deleted: 1,
              time_observed: 1,
            })
            .run()
            .pipe(Effect.orDie)
        }
        const before = yield* h.store.get(note.id)
        yield* h.permission.reply({ requestID: pending.request.id, reply: "once" })
        expect((yield* Fiber.join(pending.fiber)).output?.structured).toMatchObject({
          outcome: "unknown",
          applied: false,
          checkedFiles: 0,
        })
        expect(yield* h.store.get(note.id)).toEqual(before)
      }),
    ),
  )

for (const condition of ["missing", "large", "writer", "hardlink", "directory-alias"] as const)
  windows(`${condition} has only the supported object-evidence outcome`, () =>
    withCheck((h) =>
      Effect.gen(function* () {
        const note = yield* h.seed()
        const file = path.join(h.directory, "source.txt")
        if (condition === "missing") yield* Effect.promise(() => unlink(file))
        if (condition === "large") yield* Effect.promise(() => writeFile(file, Buffer.alloc(51201, 97)))
        if (condition === "hardlink") {
          yield* Effect.promise(() => rename(file, path.join(h.directory, "alias.txt")))
          yield* Effect.promise(() => link(path.join(h.directory, "alias.txt"), file))
        }
        if (condition === "directory-alias") {
          yield* Effect.promise(() => symlink(h.directory, path.join(h.directory, "junction"), "junction"))
          const row = (yield* h.store.get(note.id))!
          yield* h.store.bindFiles({
            scope: h.scope,
            id: note.id,
            expectedRevision: row.fileRevision!,
            files: [{ ...(note.files as Memory.FileLinks).files[0]!, path: "junction/source.txt" }],
          })
        }
        const writer =
          condition === "writer"
            ? yield* Effect.acquireRelease(
                Effect.promise(() => open(file, "r+")),
                (handle) => Effect.promise(() => handle.close()),
              )
            : undefined
        const called = yield* h.call(selection((yield* h.store.get(note.id))!))
        expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({
          outcome: condition === "hardlink" ? "matched-at-check" : "unknown",
          checkedFiles: condition === "hardlink" ? 1 : 0,
        })
        expect((yield* h.store.get(note.id))!.files).toMatchObject({ state: "unknown" })
        if (writer) yield* Effect.promise(() => writer.write("still writable", 0))
      }),
    ),
  )

for (const invalid of [
  "provider",
  "other-session",
  "wrong-called",
  "child",
  "extra-path",
  "unknown-version",
  "outside",
  "bad-identity",
  "revision",
  "cross-location",
  "wrong-agent",
  "ambiguous",
  "workspace",
  "missing-author",
  "escape",
  "too-many",
] as const)
  windows(`${invalid} is rejected before requesting permission or reading`, () =>
    withCheck((h) =>
      Effect.gen(function* () {
        const note = yield* h.seed()
        if (["unknown-version", "outside", "bad-identity", "escape", "too-many"].includes(invalid)) {
          const links = note.files as Memory.FileLinks
          yield* h.database.db
            .update(MemoryNoteTable)
            .set({
              files:
                invalid === "unknown-version"
                  ? { version: 99 }
                  : invalid === "too-many"
                    ? {
                        ...links,
                        files: Array.from({ length: 9 }, (_, index) => ({ ...links.files[0]!, path: `file-${index}` })),
                      }
                    : {
                        ...links,
                        files: [
                          {
                            ...links.files[0]!,
                            ...(invalid === "outside"
                              ? { directory: path.dirname(h.directory) }
                              : invalid === "escape"
                                ? { path: "../source.txt" }
                                : { identity: "model-made-up" }),
                          },
                        ],
                      },
            })
            .where(eq(MemoryNoteTable.id, note.id))
            .run()
            .pipe(Effect.orDie)
        }
        const child =
          invalid === "child"
            ? yield* h.sessions.create({
                parentID: h.session.id,
                model,
                location: { directory: AbsolutePath.make(h.directory) },
              })
            : undefined
        const called = yield* h.call(
          {
            ...selection(note),
            ...(invalid === "extra-path" ? { path: "secret.txt" } : {}),
            ...(invalid === "revision" ? { expectedRevision: 99 } : {}),
          },
          child?.id,
        )
        if (["provider", "other-session", "wrong-called"].includes(invalid)) {
          const row = (yield* h.database.db
            .select()
            .from(EventTable)
            .where(eq(EventTable.id, called.source.id))
            .get()
            .pipe(Effect.orDie))!
          yield* h.database.db
            .update(EventTable)
            .set({
              data: {
                ...row.data,
                ...(invalid === "provider"
                  ? { provider: { executed: true } }
                  : invalid === "other-session"
                    ? { sessionID: "ses_other" }
                    : { input: { noteID: "mem_other", expectedRevision: 1 } }),
              },
            })
            .where(eq(EventTable.id, called.source.id))
            .run()
            .pipe(Effect.orDie)
        }
        if (invalid === "cross-location")
          yield* h.database.db
            .update(SessionTable)
            .set({ directory: path.dirname(h.directory) })
            .where(eq(SessionTable.id, h.session.id))
            .run()
            .pipe(Effect.orDie)
        if (invalid === "workspace")
          yield* h.database.db
            .run(sql`UPDATE session SET workspace_id = 'workspace_other' WHERE id = ${h.session.id}`)
            .pipe(Effect.orDie)
        if (invalid === "missing-author") called.invocation.assistantMessageID = SessionMessage.ID.create()
        if (invalid === "wrong-agent") called.invocation.agent = AgentV2.ID.make("other")
        if (invalid === "ambiguous") {
          const row = (yield* h.database.db
            .select()
            .from(EventTable)
            .where(eq(EventTable.id, called.source.id))
            .get()
            .pipe(Effect.orDie))!
          yield* h.database.db
            .insert(EventTable)
            .values({ ...row, id: EventV2.ID.create(), seq: row.seq + 1000 })
            .run()
            .pipe(Effect.orDie)
        }
        yield* h.rules("ask")
        const before = yield* h.store.get(note.id)
        expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({
          outcome: "unknown",
          applied: false,
        })
        expect(yield* h.permission.forSession(child?.id ?? h.session.id)).toEqual([])
        expect(yield* h.store.get(note.id)).toEqual(before)
      }),
    ),
  )

windows("a real CAS storage failure is not swallowed as a successful file check", () =>
  withCheck((h) =>
    Effect.gen(function* () {
      const note = yield* h.seed()
      yield* h.database.db
        .run(
          sql`CREATE TRIGGER reject_check BEFORE UPDATE OF files ON memory_note BEGIN SELECT RAISE(ABORT, 'fixture check failure'); END`,
        )
        .pipe(Effect.orDie)
      const called = yield* h.call(selection(note))
      expect((yield* h.captured.settle(called.invocation).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* h.store.get(note.id)).toEqual(note)
      yield* Effect.promise(() => writeFile(path.join(h.directory, "source.txt"), "locks released"))
    }),
  ),
)

for (const bytes of [Buffer.alloc(0), Buffer.from([0xef, 0xbb, 0xbf, 97]), Buffer.alloc(51200, 97)])
  windows(`exact raw ${bytes.length}-byte evidence including BOM/empty/boundary matches`, () =>
    withCheck((h) =>
      Effect.gen(function* () {
        const note = yield* h.seed(undefined, undefined, bytes)
        expect(
          (yield* h.captured.settle((yield* h.call(selection(note))).invocation)).output?.structured,
        ).toMatchObject({ outcome: "matched-at-check", checkedFiles: 1 })
      }),
    ),
  )

windows("a single path replaced during permission is unknown and the new object is not consumed", () =>
  withCheck((h) =>
    Effect.gen(function* () {
      const note = yield* h.seed()
      yield* h.rules("ask")
      const pending = yield* h.start(yield* h.call(selection(note)))
      yield* Effect.promise(() => rename(path.join(h.directory, "source.txt"), path.join(h.directory, "old.txt")))
      yield* Effect.promise(() => writeFile(path.join(h.directory, "source.txt"), "unapproved replacement"))
      yield* h.permission.reply({ requestID: pending.request.id, reply: "once" })
      expect((yield* Fiber.join(pending.fiber)).output?.structured).toMatchObject({
        outcome: "unknown",
        checkedFiles: 0,
      })
      expect((yield* h.store.get(note.id))!.files).toMatchObject({ state: "unknown" })
    }),
  ),
)

for (const state of ["changed", "missing"] as const)
  windows(`matching bytes never clear a preexisting ${state} alert`, () =>
    withCheck((h) =>
      Effect.gen(function* () {
        const note = yield* h.seed()
        yield* h.store.checkFiles({
          scope: h.scope,
          id: note.id,
          expectedRevision: note.fileRevision!,
          results: [{ path: "source.txt", state }],
        })
        const before = (yield* h.store.get(note.id))!
        expect(
          (yield* h.captured.settle((yield* h.call(selection(before))).invocation)).output?.structured,
        ).toMatchObject({ outcome: "matched-at-check", applied: true })
        const after = (yield* h.store.get(note.id))!
        expect(after.files).toMatchObject({ state })
        expect([after.text, after.origin, after.status]).toEqual([before.text, before.origin, before.status])
      }),
    ),
  )

windows("user layer must be selected explicitly and still binds to the current directory", () =>
  withCheck((h) =>
    Effect.gen(function* () {
      const note = yield* h.seed()
      yield* h.database.db
        .update(MemoryNoteTable)
        .set({ scope: Memory.Scope.user })
        .where(eq(MemoryNoteTable.id, note.id))
        .run()
        .pipe(Effect.orDie)
      expect((yield* h.captured.settle((yield* h.call(selection(note))).invocation)).output?.structured).toMatchObject({
        outcome: "unknown",
        applied: false,
      })
      expect(
        (yield* h.captured.settle((yield* h.call({ ...selection(note), layer: "user" })).invocation)).output
          ?.structured,
      ).toMatchObject({ outcome: "matched-at-check", applied: true })
    }),
  ),
)

async function withCheck(
  body: (h: Effect.Success<typeof setup>, settings: { enabled: boolean }) => Effect.Effect<void, unknown, Scope.Scope>,
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
            MemoryCheckTool.node,
            MemoryTool.node,
            MemoryStore.node,
            SessionV2.node,
            Location.node,
            Database.node,
            EventV2.node,
            ToolRegistry.node,
            PermissionV2.node,
            AgentV2.node,
          ]),
          [
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
