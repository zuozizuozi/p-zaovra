import { expect, test } from "bun:test"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { DateTime, Deferred, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { Memory } from "@zaovra-ai/schema/memory"
import { Config } from "../src/config"
import { BackgroundJob } from "../src/background-job"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import { MemoryNoteTable } from "../src/memory/sql"
import { MemoryExtractTool } from "../src/memory/extract-tool"
import { MemoryStore } from "../src/memory/store"
import { MemoryTidyStore } from "../src/memory/tidy-store"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionExecutionStatus } from "../src/session/execution-status"
import { SessionExecutionLocal } from "../src/session/execution/local"
import { SessionRunner } from "../src/session/runner/index"
import { node } from "../src/session/runner/llm"
import { SessionMessage } from "../src/session/message"
import { SessionMessageTable } from "../src/session/sql"
import { ToolRegistry } from "../src/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { toolIdentity } from "./lib/tool"

const model = { id: ModelV2.ID.make("offline"), providerID: ProviderV2.ID.make("offline") }
type Source = { sessionID: SessionV2.ID; messageID: SessionMessage.ID; seq: number; digest: string }
type Output = {
  sessions?: { id: SessionV2.ID; title: string }[]
  messages?: { source: Source; role: string; text: string; truncated: boolean }[]
  next?: number
  nextSession?: SessionV2.ID
  kept?: boolean
  note?: Memory.Note
}
const setup = Effect.gen(function* () {
  const sessions = yield* SessionV2.Service
  const events = yield* EventV2.Service
  const store = yield* MemoryStore.Service
  const tidy = yield* MemoryTidyStore.Service
  const database = yield* Database.Service
  const here = yield* Location.Service
  const registry = yield* ToolRegistry.Service
  const jobs = yield* BackgroundJob.Service
  const execution = yield* SessionExecution.Service
  const locations = yield* LocationServiceMap.Service
  const captured = yield* registry.materialize()
  const project = yield* store.scope({ project: here.project.id, directory: here.directory })
  const create = (directory = here.directory, parentID?: SessionV2.ID) =>
    sessions.create({ model, parentID, location: { directory } })
  const turn = (
    sessionID: SessionV2.ID,
    text = "We use the isolated fixture because production data must remain untouched.",
  ) =>
    Effect.gen(function* () {
      const timestamp = yield* DateTime.now
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        timestamp,
        messageID: SessionMessage.ID.create(),
        prompt: { text: "Explain the local testing decision." },
        delivery: "steer",
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp,
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, timestamp, textID: "text" })
      yield* events.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, timestamp, textID: "text", text })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID,
        timestamp,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      return assistantMessageID
    })
  const grant = (scope = project) =>
    tidy.create(
      { requestID: randomUUID(), scope, directory: here.directory, model, tokens: 100, dailyTokens: 1000 },
      (id) =>
        sessions.create({ id, model, location: { directory: here.directory } }).pipe(
          Effect.andThen(sessions.prompt({ sessionID: id, resume: false, prompt: { text: "Tidy memories" } })),
          Effect.map((input) => ({ id: input.id, seq: input.admittedSeq })),
          Effect.orDie,
        ),
    )
  const call = (sessionID: SessionV2.ID, input: Record<string, unknown>) =>
    captured.settle({
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: randomUUID(), name: "memory_extract", input },
    })
  const read = (sessionID: SessionV2.ID, from: SessionV2.ID) =>
    call(sessionID, { action: "read", sessionID: from }).pipe(
      Effect.map((result) => {
        expect(result.result.type).not.toBe("error")
        return (result.output!.structured as Output).messages!
      }),
    )
  return {
    sessions,
    events,
    store,
    tidy,
    database,
    jobs,
    execution,
    locations,
    here,
    project,
    create,
    turn,
    grant,
    call,
    read,
  }
})

test("confirmed tidy extracts a source-bound unchecked note; retries, user edits and deletion remain authoritative", () =>
  withExtraction((h) =>
    Effect.gen(function* () {
      const original = yield* h.create()
      yield* h.turn(original.id)
      const run = yield* h.grant()
      const listed = yield* h.call(run.session_id, { action: "list" })
      expect((listed.output!.structured as Output).sessions!.map((item) => item.id)).toEqual([original.id])
      const passage = (yield* h.read(run.session_id, original.id)).find((item) => item.role === "assistant")!
      const input = {
        action: "save",
        source: passage.source,
        quote: passage.text,
        kind: "decision",
        text: "Use isolated fixtures to protect production data.",
      }
      const saved = yield* h.call(run.session_id, input)
      expect(saved.result.type).not.toBe("error")
      const note = (saved.output!.structured as Output).note!
      expect(note).toMatchObject({
        origin: "consolidation",
        status: "unverified",
        sessionID: original.id,
        seq: passage.source.seq,
      })
      yield* h.call(run.session_id, input)
      expect(yield* h.store.list(h.project)).toHaveLength(1)
      const reworded = {
        ...input,
        text: "Keep test data separate from real user data.",
        quote: "production data must remain untouched",
      }
      expect(((yield* h.call(run.session_id, reworded)).output!.structured as Output).note!.id).toBe(note.id)
      yield* h.store.edit(note.id, { text: "User correction must remain authoritative." })
      yield* h.call(run.session_id, input)
      yield* h.call(run.session_id, reworded)
      expect((yield* h.store.get(note.id))!.text).toBe("User correction must remain authoritative.")
      yield* h.store.remove(note.id)
      expect((yield* h.call(run.session_id, input)).output?.structured).toMatchObject({ kept: false })
      expect((yield* h.call(run.session_id, reworded)).output?.structured).toMatchObject({ kept: false })
      expect(yield* h.store.list(h.project)).toEqual([])
    }),
  ))

for (const legacy of [false, true])
  test(`deleting an extracted note blocks a rewritten note from a copied historical passage (legacy: ${legacy})`, () =>
    withExtraction((h) =>
      Effect.gen(function* () {
        const sources = yield* Effect.forEach(
          ["Use a local fixture for tests.", "Use a local fixture for tests.", "Use a separate account for billing."],
          (text) =>
            Effect.gen(function* () {
              const session = yield* h.create()
              yield* h.turn(session.id, text)
              return session.id
            }),
        )
        const run = yield* h.grant()
        const save = (index: number, text: string) =>
          Effect.gen(function* () {
            const passage = (yield* h.read(run.session_id, sources[index]!)).find((m) => m.role === "assistant")!
            return (yield* h.call(run.session_id, {
              action: "save",
              kind: "decision",
              text,
              source: passage.source,
              quote: passage.text,
            })).output!.structured as Output
          })
        const first = yield* save(0, "Run tests locally.")
        if (legacy)
          yield* h.database.db
            .update(MemoryNoteTable)
            .set({ extracted_digest: null })
            .where(eq(MemoryNoteTable.id, first.note!.id))
            .run()
        yield* h.store.edit(first.note!.id, { text: "Keep the fixture local." })
        yield* h.store.remove(first.note!.id)
        expect((yield* save(1, "The test suite uses an isolated local setup.")).kept).toBe(false)
        expect((yield* save(2, "Billing uses a dedicated account.")).kept).toBe(true)
        expect(yield* h.store.list(h.project)).toHaveLength(1)
      }),
    ))

test("tidy respects an erased user note when its full passage or exact quote matches", () =>
  withExtraction((h) =>
    Effect.gen(function* () {
      const erased = "Keep billing exports on the local disk."
      const note = yield* h.store.write({
        scope: h.project,
        origin: "user",
        kind: "decision",
        status: "verified",
        text: erased,
      })
      yield* h.store.remove(note!.id)
      const run = yield* h.grant()
      for (const [source, quote, expected] of [
        [erased, "billing exports", false],
        [`Prior decision: ${erased}`, erased, false],
        ["Run weekly backups.", "weekly backups", true],
      ] as const) {
        const session = yield* h.create()
        yield* h.turn(session.id, source)
        const passage = (yield* h.read(run.session_id, session.id)).find((item) => item.role === "assistant")!
        const result = yield* h.call(run.session_id, {
          action: "save",
          kind: "decision",
          source: passage.source,
          quote,
          text: expected ? "Back up once per week." : "Exported bills stay on this computer.",
        })
        expect(result.output?.structured).toMatchObject({ kept: expected })
      }
    }),
  ))

test("ordinary, cancelled, switched-model and wrong-layer invocations cannot read or save history", () =>
  withExtraction((h, state) =>
    Effect.gen(function* () {
      const original = yield* h.create()
      yield* h.turn(original.id)
      const run = yield* h.grant()
      const passage = (yield* h.read(run.session_id, original.id)).find((item) => item.role === "assistant")!
      const save = {
        action: "save",
        source: passage.source,
        quote: passage.text,
        kind: "decision",
        text: "Unauthorized attempt",
      }
      for (const action of [{ action: "list" }, { action: "read", sessionID: original.id }, save]) {
        expect((yield* h.call(original.id, action)).result.type).toBe("error")
        expect((yield* h.call(run.session_id, { ...action, layer: "user" })).result.type).toBe("error")
      }
      state.enabled = false
      expect((yield* h.call(run.session_id, save)).result.type).toBe("error")
      state.enabled = true
      yield* h.sessions.switchModel({ sessionID: run.session_id, model: { ...model, id: ModelV2.ID.make("changed") } })
      expect((yield* h.call(run.session_id, save)).result.type).toBe("error")
      yield* h.tidy.finish(run.id, "cancelled")
      expect((yield* h.call(run.session_id, { action: "list" })).result.type).toBe("error")
      expect(yield* h.store.list(h.project)).toEqual([])
    }),
  ))

test("source selection excludes other directories, children, tidy, active, incomplete and queued sessions", () =>
  withExtraction((h, state) =>
    Effect.gen(function* () {
      const original = yield* h.create()
      yield* h.turn(original.id)
      const outside = yield* h.create(AbsolutePath.make(path.join(h.here.directory, "other")))
      const child = yield* h.create(h.here.directory, original.id)
      const busy = yield* h.create()
      const queued = yield* h.create()
      const incomplete = yield* h.create()
      for (const id of [outside.id, child.id, busy.id, queued.id]) yield* h.turn(id)
      state.active.add(busy.id)
      yield* h.sessions.prompt({
        sessionID: queued.id,
        resume: false,
        prompt: { text: "Not promoted yet" },
        delivery: "queue",
      })
      const run = yield* h.grant()
      for (const id of [outside.id, child.id, busy.id, queued.id, incomplete.id, run.session_id])
        expect((yield* h.call(run.session_id, { action: "read", sessionID: id })).result.type).toBe("error")
      expect(
        ((yield* h.call(run.session_id, { action: "list" })).output!.structured as Output).sessions!.map(
          (item) => item.id,
        ),
      ).toEqual([original.id])
    }),
  ))

test("save rejects fabricated, changed and cross-session provenance with zero writes", () =>
  withExtraction((h, state) =>
    Effect.gen(function* () {
      const original = yield* h.create()
      yield* h.turn(original.id)
      const other = yield* h.create()
      yield* h.turn(other.id)
      const run = yield* h.grant()
      const passage = (yield* h.read(run.session_id, original.id)).find((item) => item.role === "assistant")!
      const input = {
        action: "save",
        source: passage.source,
        quote: passage.text,
        kind: "decision",
        text: "Keep this reusable lesson",
      }
      state.active.add(original.id)
      expect((yield* h.call(run.session_id, input)).result.type).toBe("error")
      state.active.delete(original.id)
      for (const source of [
        { ...passage.source, sessionID: other.id },
        { ...passage.source, messageID: SessionMessage.ID.create() },
        { ...passage.source, seq: passage.source.seq + 1 },
        { ...passage.source, digest: "fabricated" },
      ])
        expect((yield* h.call(run.session_id, { ...input, source })).result.type).toBe("error")
      expect((yield* h.call(run.session_id, { ...input, quote: "This was never said." })).result.type).toBe("error")
      const row = yield* h.database.db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, passage.source.messageID))
        .get()
        .pipe(Effect.orDie)
      const changed = Schema.encodeSync(SessionMessage.Assistant)({
        ...Schema.decodeUnknownSync(SessionMessage.Assistant)({ ...row!.data, id: row!.id, type: "assistant" }),
        content: [],
      })
      yield* h.database.db
        .update(SessionMessageTable)
        .set({ data: changed })
        .where(eq(SessionMessageTable.id, row!.id))
        .run()
        .pipe(Effect.orDie)
      expect((yield* h.call(run.session_id, input)).result.type).toBe("error")
      expect(yield* h.store.list(h.project)).toEqual([])
    }),
  ))

test("a user-layer tidy stores only in its authorized layer without admitting another directory's history", () =>
  withExtraction((h) =>
    Effect.gen(function* () {
      const original = yield* h.create()
      yield* h.turn(original.id)
      const run = yield* h.grant(Memory.Scope.user)
      const result = yield* h.call(run.session_id, { action: "read", layer: "user", sessionID: original.id })
      const passage = (result.output!.structured as Output).messages!.find((item) => item.role === "assistant")!
      const saved = yield* h.call(run.session_id, {
        action: "save",
        layer: "user",
        source: passage.source,
        quote: passage.text,
        kind: "preference",
        text: "Prefer isolated test data.",
      })
      expect(saved.result.type).not.toBe("error")
      expect((saved.output!.structured as Output).note).toMatchObject({
        scope: Memory.Scope.user,
        status: "unverified",
        origin: "consolidation",
      })
      expect(yield* h.store.list(h.project)).toEqual([])
      const outside = yield* h.create(AbsolutePath.make(path.join(h.here.directory, "other")))
      yield* h.turn(outside.id)
      expect(
        (yield* h.call(run.session_id, { action: "read", layer: "user", sessionID: outside.id })).result.type,
      ).toBe("error")
    }),
  ))

test("session discovery can continue past a bounded page without exposing foreign cursors", () =>
  withExtraction((h) =>
    Effect.gen(function* () {
      const ids = yield* Effect.forEach(Array.from({ length: 23 }), () =>
        h.create().pipe(
          Effect.tap((session) => h.turn(session.id)),
          Effect.map((session) => session.id),
        ),
      )
      const run = yield* h.grant()
      const first = (yield* h.call(run.session_id, { action: "list" })).output!.structured as Output
      expect(first.sessions).toHaveLength(20)
      expect(first.nextSession).toBeDefined()
      const second = (yield* h.call(run.session_id, { action: "list", before: first.nextSession })).output!
        .structured as Output
      expect(second.sessions).toHaveLength(3)
      expect(second.nextSession).toBeUndefined()
      expect([...first.sessions!, ...second.sessions!].map((session) => session.id).sort()).toEqual(ids.sort())
      const outside = yield* h.create(AbsolutePath.make(path.join(h.here.directory, "other")))
      expect((yield* h.call(run.session_id, { action: "list", before: outside.id })).result.type).toBe("error")
    }),
  ))

test("historical text pages are bounded and retain exact source identity across pagination", () =>
  withExtraction((h) =>
    Effect.gen(function* () {
      const original = yield* h.create()
      for (let i = 0; i < 6; i++) yield* h.turn(original.id, "历史事实".repeat(1100))
      const run = yield* h.grant()
      const first = (yield* h.call(run.session_id, { action: "read", sessionID: original.id })).output!
        .structured as Output
      expect(first.messages).toHaveLength(10)
      expect(first.messages!.every((item) => item.text.length <= 4000)).toBe(true)
      expect(first.messages!.some((item) => item.truncated)).toBe(true)
      const next = (yield* h.call(run.session_id, { action: "read", sessionID: original.id, after: first.next }))
        .output!.structured as Output
      expect(next.messages).toHaveLength(2)
      expect(next.next).toBeUndefined()
      expect(new Set([...first.messages!, ...next.messages!].map((item) => item.source.messageID)).size).toBe(12)
    }),
  ))

test("missing execution authority is unknown, never assumed idle", () =>
  withExtraction(
    (h) =>
      Effect.gen(function* () {
        const original = yield* h.create()
        yield* h.turn(original.id)
        const run = yield* h.grant()
        expect((yield* h.call(run.session_id, { action: "read", sessionID: original.id })).result.type).toBe("error")
        expect(((yield* h.call(run.session_id, { action: "list" })).output!.structured as Output).sessions).toEqual([])
      }),
    false,
  ))

test("live background work and unfinished manual shells exclude completed assistant tails", () =>
  withExtraction((h) =>
    Effect.gen(function* () {
      const background = yield* h.create()
      yield* h.turn(background.id)
      const job = yield* h.jobs.start({ type: "fixture", metadata: { sessionID: background.id }, run: Effect.never })
      const shell = yield* h.create()
      yield* h.events.publish(SessionEvent.Shell.Started, {
        sessionID: shell.id,
        messageID: SessionMessage.ID.create(),
        callID: "fixture-shell",
        command: "fixture",
        origin: "manual",
        timestamp: yield* DateTime.now,
      })
      yield* h.turn(shell.id)
      const run = yield* h.grant()
      for (const sessionID of [background.id, shell.id])
        expect((yield* h.call(run.session_id, { action: "read", sessionID })).result.type).toBe("error")
      yield* h.jobs.cancel(job.id)
      expect((yield* h.call(run.session_id, { action: "read", sessionID: background.id })).result.type).not.toBe(
        "error",
      )
    }),
  ))

test("production coordinator and actual Location tool share live activity without an execution dependency cycle", () =>
  withExtraction(
    (h, state) =>
      Effect.gen(function* () {
        const original = yield* h.create()
        yield* h.turn(original.id)
        const run = yield* h.grant()
        const tools = yield* ToolRegistry.Service.use((registry) => registry.materialize()).pipe(
          Effect.provide(h.locations.get({ directory: h.here.directory })),
        )
        const read = () =>
          tools.settle({
            sessionID: run.session_id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: randomUUID(),
              name: "memory_extract",
              input: { action: "read", sessionID: original.id },
            },
          })
        expect((yield* read()).result.type).not.toBe("error")
        const running = yield* h.execution.resume(original.id).pipe(Effect.forkChild)
        yield* Deferred.await(state.entered)
        expect((yield* read()).result.type).toBe("error")
        yield* Deferred.succeed(state.release, undefined)
        yield* Fiber.join(running)
        expect((yield* read()).result.type).not.toBe("error")
      }),
    "local",
  ))

async function withExtraction(
  body: (
    h: Effect.Success<typeof setup>,
    state: {
      enabled: boolean
      active: Set<SessionV2.ID>
      entered: Deferred.Deferred<void>
      release: Deferred.Deferred<void>
    },
  ) => Effect.Effect<void, unknown, Scope.Scope>,
  tracked: boolean | "local" = true,
) {
  await using tmp = await tmpdir()
  const state = {
    enabled: true,
    active: new Set<SessionV2.ID>(),
    entered: Deferred.makeUnsafe<void>(),
    release: Deferred.makeUnsafe<void>(),
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const status = yield* SessionExecutionStatus.Service
      if (tracked === true) yield* status.track(Effect.sync(() => state.active))
      yield* body(yield* setup, state)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            MemoryExtractTool.node,
            Database.node,
            EventV2.node,
            MemoryStore.node,
            MemoryTidyStore.node,
            SessionV2.node,
            Location.node,
            ToolRegistry.node,
            SessionExecutionStatus.node,
            BackgroundJob.node,
            SessionExecution.node,
            LocationServiceMap.node,
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
            [
              SessionExecution.node,
              tracked === "local"
                ? SessionExecutionLocal.node
                : Layer.succeed(
                    SessionExecution.Service,
                    SessionExecution.Service.of({
                      active: Effect.sync(() => state.active),
                      resume: () => Effect.void,
                      wake: () => Effect.void,
                      interrupt: () => Effect.void,
                    }),
                  ),
            ],
            [
              node,
              Layer.succeed(
                SessionRunner.Service,
                SessionRunner.Service.of({
                  run: () =>
                    Deferred.succeed(state.entered, undefined).pipe(Effect.andThen(Deferred.await(state.release))),
                  compact: () => Effect.succeed(false),
                }),
              ),
            ],
            [
              Config.node,
              Layer.succeed(
                Config.Service,
                Config.Service.of({
                  entries: () =>
                    Effect.sync(() => [
                      new Config.Document({
                        type: "document",
                        info: new Config.Info({ memory: { enabled: state.enabled } }),
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
