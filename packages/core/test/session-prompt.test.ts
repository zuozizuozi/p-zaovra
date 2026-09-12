import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { EventTable } from "@zaovra-ai/core/event/sql"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { Project } from "@zaovra-ai/core/project"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { AbsolutePath, RelativePath } from "@zaovra-ai/core/schema"
import { SessionTurnDiff } from "@zaovra-ai/core/session/turn-diff"
import { Model } from "@zaovra-ai/schema/model"
import { Provider } from "@zaovra-ai/schema/provider"
import { Snapshot } from "@zaovra-ai/core/snapshot"
import { SessionV2 } from "@zaovra-ai/core/session"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { Prompt } from "@zaovra-ai/core/session/prompt"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionProjector } from "@zaovra-ai/core/session/projector"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionInput } from "@zaovra-ai/core/session/input"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@zaovra-ai/core/session/sql"
import { SessionStore } from "@zaovra-ai/core/session/store"
import { testEffect } from "./lib/effect"

const executionCalls: SessionV2.ID[] = []
const interruptCalls: SessionV2.ID[] = []
const wakeCalls: SessionV2.ID[] = []
const activeSessions = new Set<SessionV2.ID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set(activeSessions)),
    resume: (sessionID) =>
      Effect.sync(() => {
        executionCalls.push(sessionID)
      }),
    interrupt: (sessionID) =>
      Effect.sync(() => {
        interruptCalls.push(sessionID)
      }),
    wake: (sessionID) =>
      Effect.sync(() => {
        wakeCalls.push(sessionID)
      }),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [[SessionExecution.node, execution]],
  ),
)
const sessionID = SessionV2.ID.make("ses_prompt_test")
const messageID = SessionMessage.ID.create()

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const admitted = (id: SessionMessage.ID) => Database.Service.use(({ db }) => SessionInput.find(db, id))
const admittedCount = Database.Service.use(({ db }) =>
  db
    .select()
    .from(SessionInputTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    ),
)
const eventCount = (type: string) =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(EventTable)
      .where(eq(EventTable.type, type))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length),
      ),
  )

describe("SessionV2.prompt", () => {
  it.effect("applies a queued input's model and agent only when it is promoted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const before = yield* session.get(sessionID)
      const selection = {
        agent: "plan",
        model: { id: Model.ID.make("queued-model"), providerID: Provider.ID.make("queued-provider") },
      }
      const input = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Later", selection }),
        delivery: "queue",
        resume: false,
      })
      expect((yield* session.get(sessionID)).model).toEqual(before.model)
      expect((yield* session.get(sessionID)).agent).toEqual(before.agent)
      expect((yield* session.pendingInputs(sessionID))[0].prompt.selection).toEqual(selection)
      const conflict = yield* session
        .prompt({
          id: input.id,
          sessionID,
          prompt: Prompt.make({ text: "Later", selection: { ...selection, agent: "build" } }),
          delivery: "queue",
          resume: false,
        })
        .pipe(Effect.flip)
      expect(conflict._tag).toBe("Session.PromptConflictError")
      expect(yield* SessionInput.promoteNextQueued(database.db, events, sessionID)).toBe(true)
      expect((yield* session.get(sessionID)).model).toMatchObject(selection.model)
      expect((yield* session.get(sessionID)).agent).toBe(AgentV2.ID.make("plan"))
      const messages = yield* session.messages({ sessionID })
      expect(messages[0].type === "user" && messages[0].selection).toEqual(selection)
    }),
  )

  it.effect("plans changes from persisted snapshots within exactly one user turn", () =>
    Effect.gen(function* () {
      yield* setup
      const events = yield* EventV2.Service
      const timestamp = yield* DateTime.now
      const first = SessionMessage.ID.create()
      const next = SessionMessage.ID.create()
      for (const turn of [
        { id: first, snapshots: ["before", "middle", "after"] },
        { id: next, snapshots: ["later-before", "later-after"] },
      ]) {
        yield* events.publish(SessionEvent.Prompted, {
          sessionID,
          timestamp,
          messageID: turn.id,
          prompt: Prompt.make({ text: "Edit" }),
          delivery: "steer",
        })
        for (let index = 1; index < turn.snapshots.length; index++) {
          const assistantMessageID = SessionMessage.ID.create()
          yield* events.publish(SessionEvent.Step.Started, {
            sessionID,
            timestamp,
            assistantMessageID,
            agent: "build",
            model: { id: Model.ID.make("test"), providerID: Provider.ID.make("test") },
            snapshot: turn.snapshots[index - 1],
          })
          yield* events.publish(SessionEvent.Step.Ended, {
            sessionID,
            timestamp,
            assistantMessageID,
            finish: "stop",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            snapshot: turn.snapshots[index],
            files: [RelativePath.make(turn.id === first ? "first.txt" : "next.txt")],
          })
        }
      }
      expect(yield* SessionTurnDiff.plan({ sessionID, messageID: first })).toEqual({
        from: Snapshot.ID.make("before"),
        to: Snapshot.ID.make("after"),
        paths: [RelativePath.make("first.txt")],
      })
      expect(yield* SessionTurnDiff.plan({ sessionID, messageID: next })).toEqual({
        from: Snapshot.ID.make("later-before"),
        to: Snapshot.ID.make("later-after"),
        paths: [RelativePath.make("next.txt")],
      })
      const error = yield* SessionTurnDiff.plan({ sessionID, messageID: SessionMessage.ID.create() }).pipe(Effect.flip)
      expect(error._tag).toBe("Session.MessageNotFoundError")
    }),
  )

  it.effect("cancels pending input durably without allowing an old retry to wake it", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: SessionMessage.ID.create(),
        prompt: Prompt.make({ text: "Queued work" }),
        delivery: "queue" as const,
        resume: false,
      }
      yield* session.prompt(input)
      const cancelled = yield* session.cancelInput({ sessionID, messageID: input.id })
      expect(cancelled.cancelledSeq).toBeDefined()
      expect(yield* session.pendingInputs(sessionID)).toEqual([])
      expect(yield* session.cancelInput({ sessionID, messageID: input.id })).toEqual(cancelled)
      wakeCalls.length = 0
      expect(yield* session.prompt({ ...input, resume: true })).toEqual(cancelled)
      expect(wakeCalls).toEqual([])
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      expect(yield* SessionInput.promoteNextQueued(database.db, events, sessionID)).toBe(false)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptCancelled.type, 1))).toBe(1)
    }),
  )

  it.effect("rejects cancelling an input that already entered the transcript", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run work" }),
        delivery: "queue",
        resume: false,
      })
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      expect(yield* SessionInput.promoteNextQueued(database.db, events, sessionID)).toBe(true)
      const error = yield* session.cancelInput({ sessionID, messageID: input.id }).pipe(Effect.flip)
      expect(error._tag).toBe("Session.PromptConflictError")
      expect((yield* admitted(input.id))?.cancelledSeq).toBeUndefined()
    }),
  )

  it.effect("keeps cancellation exclusive with concurrent promotion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const input = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Race" }),
        delivery: "queue",
        resume: false,
      })
      yield* Effect.all(
        [
          session
            .cancelInput({ sessionID, messageID: input.id })
            .pipe(Effect.catchTag("Session.PromptConflictError", () => Effect.void)),
          SessionInput.promoteNextQueued(database.db, events, sessionID),
        ],
        { concurrency: "unbounded" },
      )
      const stored = yield* admitted(input.id)
      expect(stored).toBeDefined()
      expect(stored!.cancelledSeq !== undefined).toBe(stored!.promotedSeq === undefined)
      expect((yield* session.messages({ sessionID })).length).toBe(stored!.promotedSeq === undefined ? 0 : 1)
    }),
  )

  it.effect("replays cancellation without resurrecting pending work", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const input = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Cancel then replay" }),
        delivery: "queue",
        resume: false,
      })
      const cancelled = yield* session.cancelInput({ sessionID, messageID: input.id })
      const recorded = yield* database.db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      yield* events.remove(sessionID)
      yield* database.db
        .delete(SessionInputTable)
        .where(eq(SessionInputTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* events.replayAll(
        recorded.map((event) => ({
          id: event.id,
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )
      expect(yield* admitted(input.id)).toEqual(cancelled)
      expect(yield* session.pendingInputs(sessionID)).toEqual([])
    }),
  )

  it.effect("exposes the execution registry", () =>
    Effect.gen(function* () {
      activeSessions.add(sessionID)
      expect(Array.from(yield* (yield* SessionV2.Service).active)).toEqual([sessionID])
    }).pipe(Effect.ensuring(Effect.sync(() => activeSessions.clear()))),
  )

  it.effect("delegates execution continuation through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("delegates process-local interruption through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      interruptCalls.length = 0

      yield* session.interrupt(sessionID)
      expect(interruptCalls).toEqual([sessionID])
      expect(yield* session.messages({ sessionID })).toEqual([])
    }),
  )

  it.effect("delegates interruption without requiring a recorded Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      interruptCalls.length = 0

      yield* session.interrupt(SessionV2.ID.make("ses_missing"))
      expect(interruptCalls).toEqual([SessionV2.ID.make("ses_missing")])
    }),
  )

  it.effect("durably admits one user message before transcript promotion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })

      expect(message.prompt.text).toBe("Fix the failing tests")
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).toMatchObject({
        id: message.id,
        sessionID,
        prompt: { text: "Fix the failing tests" },
        delivery: "steer",
      })
    }),
  )

  it.effect("lists pending inputs in durable admission order until promotion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const first = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Apply this requirement" }),
        resume: false,
      })
      const second = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do this next" }),
        delivery: "queue",
        resume: false,
      })

      expect((yield* session.pendingInputs(sessionID)).map((input) => input.id)).toEqual([first.id, second.id])

      const db = (yield* Database.Service).db
      yield* SessionInput.promoteSteers(db, yield* EventV2.Service, sessionID, Number.MAX_SAFE_INTEGER)
      expect((yield* session.pendingInputs(sessionID)).map((input) => input.id)).toEqual([second.id])
    }),
  )

  it.effect("resolves attachment MIME before admission", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const message = yield* session.prompt({
        sessionID,
        prompt: {
          text: "Inspect this image",
          files: [{ uri: "data:image/png;base64,aGVsbG8=", name: "image.png" }],
        },
        resume: false,
      })

      expect(message.prompt.files).toEqual([
        { uri: "data:image/png;base64,aGVsbG8=", name: "image.png", mime: "image/png" },
      ])
      expect((yield* admitted(message.id))?.prompt.files).toEqual(message.prompt.files)
    }),
  )

  it.effect("streams durable Session events after an aggregate sequence", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const fiber = yield* session.events({ sessionID }).pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const streamed = Array.from(yield* Fiber.join(fiber))

      expect(streamed.map((event) => [event.durable?.seq, event.type])).toEqual([
        [0, "session.next.prompt.admitted"],
        [1, "session.next.prompt.admitted"],
        [2, "session.next.prompted"],
        [3, "session.next.prompted"],
      ])
      expect(
        Array.from(
          yield* session
            .events({ sessionID, after: streamed[0]!.durable?.seq })
            .pipe(Stream.take(1), Stream.runCollect),
        ).map((event) => [event.durable?.seq, event.type]),
      ).toEqual([[1, "session.next.prompt.admitted"]])
    }),
  )

  it.effect("resumes through a recorded message without appending another prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })

      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)

      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).not.toHaveProperty("promotedSeq")
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("records distinct messages when the ID is omitted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = { sessionID, prompt: Prompt.make({ text: "Fix the failing tests" }), resume: false }

      const first = yield* session.prompt(input)
      const second = yield* session.prompt(input)

      expect(second.id).not.toBe(first.id)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(2)
    }),
  )

  it.effect("returns the original recorded message when the ID is retried", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      }

      const first = yield* session.prompt(input)
      const retried = yield* session.prompt(input)

      expect(retried).toEqual(first)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("wakes execution when an exact prompt retry recovers a committed message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Recover committed prompt" }),
        resume: false,
      }
      const first = yield* session.prompt(input)
      wakeCalls.length = 0

      const retried = yield* session.prompt({ ...input, resume: true })

      expect(retried).toEqual(first)
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("rejects reuse of one ID with a different prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
      })
      const failure = yield* session
        .prompt({
          sessionID,
          id: messageID,
          prompt: Prompt.make({ text: "Delete the failing tests" }),
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
      expect(yield* session.messages({ sessionID })).toHaveLength(0)
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("rejects reuse of one ID with a different delivery mode", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })
      const failure = yield* session
        .prompt({
          id: messageID,
          sessionID,
          prompt: Prompt.make({ text: "Fix the failing tests" }),
          delivery: "queue",
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
    }),
  )

  it.effect("returns one recorded message to concurrent exact retries", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      }

      const messages = yield* Effect.all([session.prompt(input), session.prompt(input)], { concurrency: "unbounded" })

      expect(messages[1]).toEqual(messages[0])
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1))).toBe(1)
    }),
  )

  it.effect("promotes one message once under concurrent promotion attempts", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "Promote once" }), resume: false })

      yield* Effect.all(
        [
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
        ],
        { concurrency: "unbounded" },
      )

      expect(yield* eventCount(EventV2.versionedType(SessionEvent.Prompted.type, 1))).toBe(1)
      expect(yield* admitted(messageID)).toMatchObject({ promotedSeq: 1 })
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: messageID, type: "user", text: "Promote once" },
      ])
    }),
  )

  it.effect("promotes steers only through the captured inbox cutoff", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const first = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Before cutoff" }), resume: false })
      const cutoff = first.admittedSeq
      const second = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "After cutoff" }), resume: false })

      yield* SessionInput.promoteSteers(db, events, sessionID, cutoff)

      expect(yield* admitted(first.id)).toHaveProperty("promotedSeq")
      expect(yield* admitted(second.id)).not.toHaveProperty("promotedSeq")
    }),
  )

  it.effect("reprojects pending inbox input without scheduling execution", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      wakeCalls.length = 0
      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Replay pending" }),
        resume: false,
      })
      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      yield* events.remove(sessionID)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie)
      yield* db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* events.replayAll(
        recorded.map((event) => ({
          id: event.id,
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )

      expect(yield* admitted(messageID)).toMatchObject({ id: messageID, prompt: { text: "Replay pending" } })
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("returns an exact retry of a legacy projected prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const prompt = Prompt.make({ text: "Historical prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "steer",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical prompt" } })
      expect(yield* admitted(messageID)).toHaveProperty("promotedSeq")
    }),
  )

  it.effect("returns an exact retry of a legacy projected queued prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const prompt = Prompt.make({ text: "Historical queued prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "queue",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, delivery: "queue", resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical queued prompt" } })
      expect(yield* admitted(messageID)).toMatchObject({ delivery: "queue" })
    }),
  )

  it.effect("rejects reuse of one globally unique message ID across sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const other = SessionV2.ID.make("ses_prompt_other")
      yield* db
        .insert(SessionTable)
        .values({
          id: other,
          project_id: Project.ID.global,
          slug: "other",
          directory: "/project",
          title: "other",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const prompt = Prompt.make({ text: "Fix the failing tests" })

      yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })
      const failure = yield* session
        .prompt({ id: messageID, sessionID: other, prompt, resume: false })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID: other, messageID })
    }),
  )

  it.effect("rejects a prompt ID already used by visible Session history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        text: "Existing history",
      })

      const failure = yield* session
        .prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "Conflicting prompt" }), resume: false })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID, messageID })
      expect(yield* admitted(messageID)).toBeUndefined()
    }),
  )

  it.effect("starts execution by default after recording the prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run by default" }) })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("starts execution when resume is explicitly true", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run explicitly" }),
        resume: true,
      })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("only records the prompt when resume is false", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Do not run" }), resume: false })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )
})
