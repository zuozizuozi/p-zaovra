import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { Project } from "@zaovra-ai/core/project"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { SessionInput } from "@zaovra-ai/core/session/input"
import { SessionLive } from "@zaovra-ai/core/session/live"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { Prompt } from "@zaovra-ai/core/session/prompt"
import { SessionProjector } from "@zaovra-ai/core/session/projector"
import { SessionMessageTable, SessionTable } from "@zaovra-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionLive.node])),
)
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])
const sessionID = SessionV2.ID.make("ses_turn_pages")
const id = (index: number) => SessionMessage.ID.make(`msg_page_${index}`)
const created = DateTime.makeUnsafe(0)
const user = (index: number) =>
  SessionMessage.User.make({ id: id(index), type: "user", text: `input ${index}`, time: { created } })
const shell = (index: number, turn?: SessionMessage.ID) =>
  SessionMessage.Shell.make({
    id: id(index),
    type: "shell",
    callID: `call_${index}`,
    command: "echo done",
    output: "done",
    time: { created },
    turn,
  })
function row(message: SessionMessage.Message, seq: number, session = sessionID) {
  const { id: _, type, ...data } = Schema.encodeSync(SessionMessage.Message)(message)
  return { id: message.id, session_id: session, type, seq, time_created: 0, data }
}
const seed = Effect.fn(function* (messages: SessionMessage.Message[]) {
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({
      id: Project.ID.global,
      worktree: AbsolutePath.make("/project"),
      sandboxes: [],
    })
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  if (messages.length === 0) return
  yield* database.db
    .insert(SessionMessageTable)
    .values(messages.map((message, seq) => row(message, seq)))
    .run()
    .pipe(Effect.orDie)
})
const timeline = () =>
  Array.from({ length: 12 }, (_, index) => ([2, 5, 9].includes(index) ? user(index) : shell(index)))

describe("session message turn pages", () => {
  it.effect("expanded pages include durable projected tools and the later pending input watermark", () =>
    Effect.gen(function* () {
      yield* seed([])
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const sessions = yield* SessionV2.Service
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID: id(0),
        timestamp: created,
        prompt: Prompt.make({ text: "run tools" }),
        delivery: "steer",
      })
      yield* Effect.forEach([1, 2, 3], (index) =>
        events.publish(SessionEvent.Shell.Started, {
          sessionID,
          messageID: id(index),
          timestamp: created,
          callID: `call_${index}`,
          command: "echo done",
        }),
      )
      const pending = yield* SessionInput.admit(database.db, events, {
        sessionID,
        id: id(4),
        prompt: Prompt.make({ text: "queued" }),
        delivery: "queue",
      })
      expect(pending).toBeDefined()
      const page = yield* sessions.page({ sessionID, limit: 1, boundary: "turn" })
      expect(page.messages.map((message) => message.id)).toEqual([3, 2, 1, 0].map(id))
      expect(page.messages.map((message) => message.turn)).toEqual([id(0), id(0), id(0), id(0)])
      expect(page.pending.map((input) => input.id)).toEqual([id(4)])
      expect(page.watermark).toBe(yield* EventV2.latestSequence(database.db, sessionID))
      expect(page.watermark).toBeGreaterThan(page.messages[0]!.seq!)
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("includes the real user behind 352 messages without changing the legacy hard limit", () =>
    Effect.gen(function* () {
      yield* seed([user(0), ...Array.from({ length: 352 }, (_, index) => shell(index + 1, id(0)))])
      const sessions = yield* SessionV2.Service
      const legacy = yield* sessions.messages({ sessionID, limit: 20 })
      expect(legacy).toHaveLength(20)
      expect(legacy.some((message) => message.type === "user")).toBe(false)
      const page = yield* sessions.page({ sessionID, limit: 20, boundary: "turn" })
      expect(page.messages.map((message) => message.id)).toEqual(Array.from({ length: 353 }, (_, i) => id(352 - i)))
      expect(page.messages.at(-1)?.type).toBe("user")
      expect(page.pending).toEqual([])
      expect(page.execution.active).toBe(false)
    }).pipe(Effect.provide(sessionsLayer)),
  )

  for (const order of ["asc", "desc"] as const) {
    it.effect(`${order} pages preserve complete chronological turns and previous/next traversal`, () =>
      Effect.gen(function* () {
        yield* seed(timeline())
        const sessions = yield* SessionV2.Service
        const request = { sessionID, limit: 2, order, boundary: "turn" as const }
        const first = yield* sessions.messages(request)
        const second = yield* sessions.messages({ ...request, cursor: { id: first.at(-1)!.id, direction: "next" } })
        const third = yield* sessions.messages({ ...request, cursor: { id: second.at(-1)!.id, direction: "next" } })
        const fourth = yield* sessions.messages({ ...request, cursor: { id: third.at(-1)!.id, direction: "next" } })
        const expected =
          order === "asc"
            ? [
                [0, 1],
                [2, 3, 4],
                [5, 6, 7, 8],
                [9, 10, 11],
              ]
            : [
                [11, 10, 9],
                [8, 7, 6, 5],
                [4, 3, 2],
                [1, 0],
              ]
        expect([first, second, third, fourth].map((page) => page.map((message) => message.id))).toEqual(
          expected.map((page) => page.map(id)),
        )
        expect(
          (yield* sessions.messages({ ...request, cursor: { id: second[0]!.id, direction: "previous" } })).map(
            (message) => message.id,
          ),
        ).toEqual(first.map((message) => message.id))
        expect(yield* sessions.messages({ ...request, cursor: { id: fourth.at(-1)!.id, direction: "next" } })).toEqual(
          [],
        )
        expect(yield* sessions.messages({ ...request, cursor: { id: first[0]!.id, direction: "previous" } })).toEqual(
          [],
        )
      }).pipe(Effect.provide(sessionsLayer)),
    )
  }

  it.effect("does not treat shell, synthetic, or system rows as users or rewrite old background ownership", () =>
    Effect.gen(function* () {
      yield* seed([
        user(0),
        shell(1, id(0)),
        user(2),
        SessionMessage.Synthetic.make({
          id: id(3),
          type: "synthetic",
          sessionID,
          text: "background done",
          time: { created },
          turn: id(0),
          completion: { type: "bash-completion", sourceMessageID: id(1), jobID: "old-job" },
        }),
        SessionMessage.System.make({ id: id(4), type: "system", text: "status", time: { created } }),
        shell(5, id(2)),
      ])
      const sessions = yield* SessionV2.Service
      const page = yield* sessions.messages({ sessionID, limit: 1, boundary: "turn" })
      expect(page.map((message) => message.id)).toEqual([5, 4, 3, 2].map(id))
      expect(page.find((message) => message.id === id(3))?.turn).toBe(id(0))
      expect(page.find((message) => message.id === id(4))?.turn).toBeUndefined()
      const older = yield* sessions.messages({
        sessionID,
        limit: 1,
        boundary: "turn",
        cursor: { id: id(2), direction: "next" },
      })
      expect(older.map((message) => message.id)).toEqual([id(1), id(0)])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("returns an orphan legacy prefix intact and never accepts an anchor from another session", () =>
    Effect.gen(function* () {
      yield* seed([shell(0), shell(1), shell(2)])
      const sessions = yield* SessionV2.Service
      expect(
        (yield* sessions.messages({ sessionID, limit: 1, boundary: "turn" })).map((message) => message.id),
      ).toEqual([2, 1, 0].map(id))
      const database = yield* Database.Service
      const other = SessionV2.ID.make("ses_other_page")
      yield* database.db
        .insert(SessionTable)
        .values({
          id: other,
          project_id: Project.ID.global,
          slug: "other",
          directory: "/project",
          title: "other",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionMessageTable)
        .values(row(user(9), 9, other))
        .run()
        .pipe(Effect.orDie)
      for (const anchor of [id(9), id(404)]) {
        expect(
          yield* sessions.messages({
            sessionID,
            limit: 1,
            boundary: "turn",
            cursor: { id: anchor, direction: "next" },
          }),
        ).toEqual([])
      }
      expect((yield* sessions.messages({ sessionID, boundary: "turn" })).map((message) => message.id)).toEqual(
        [2, 1, 0].map(id),
      )
    }).pipe(Effect.provide(sessionsLayer)),
  )
})
