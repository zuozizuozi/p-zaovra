import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Schema } from "effect"
import { asc, eq } from "drizzle-orm"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Database } from "@zaovra-ai/core/database/database"
import { EventV2 } from "@zaovra-ai/core/event"
import { EventTable } from "@zaovra-ai/core/event/sql"
import { ModelV2 } from "@zaovra-ai/core/model"
import { Project } from "@zaovra-ai/core/project"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionMessageUpdater } from "@zaovra-ai/core/session/message-updater"
import { SessionProjector } from "@zaovra-ai/core/session/projector"
import { Prompt } from "@zaovra-ai/core/session/prompt"
import { SessionMessageTable, SessionTable } from "@zaovra-ai/core/session/sql"
import { SessionToolDisposition } from "@zaovra-ai/schema/session-tool-disposition"
import { testEffect } from "./lib/effect"
import { LLMEvent } from "@zaovra-ai/llm"
import { createLLMEventPublisher } from "@zaovra-ai/core/session/runner/publish-llm-event"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const timestamp = DateTime.makeUnsafe(100)
const sessionID = SessionV2.ID.make("ses_tool_disposition")
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const provider = { executed: false }
const input = { filePath: "/project/main.ts", oldString: "before", newString: "after" }
const base = { sessionID, timestamp }
const usage = { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }

function fixture() {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
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
    const transcript: SessionEvent.Event[] = []
    yield* events.listen((event) =>
      Effect.sync(() => {
        if (Schema.is(SessionEvent.All)(event)) transcript.push(event)
      }),
    )
    const messages = () =>
      database.db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) =>
            rows.map((row) =>
              Schema.decodeUnknownSync(SessionMessage.Message)({
                ...row.data,
                id: row.id,
                type: row.type,
                seq: row.seq,
              }),
            ),
          ),
        )
    const tool = (messageID: SessionMessage.ID, callID = "failure") =>
      messages().pipe(
        Effect.map((rows) => {
          const message = rows.find((item) => item.id === messageID)
          if (message?.type !== "assistant") throw new Error("Missing assistant")
          const part = message.content.find((item) => item.type === "tool" && item.id === callID)
          if (part?.type !== "tool") throw new Error("Missing tool")
          return part
        }),
      )
    const prompt = (text = "Update main.ts") =>
      Effect.gen(function* () {
        const messageID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Prompted, {
          ...base,
          messageID,
          prompt: Prompt.make({ text }),
          delivery: "steer",
        })
        return messageID
      })
    const start = () =>
      Effect.gen(function* () {
        const assistantMessageID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Step.Started, { ...base, assistantMessageID, model, agent: "build" })
        return assistantMessageID
      })
    const call = (assistantMessageID: SessionMessage.ID, callID: string) =>
      Effect.gen(function* () {
        yield* events.publish(SessionEvent.Tool.Input.Started, { ...base, assistantMessageID, callID, name: "edit" })
        yield* events.publish(SessionEvent.Tool.Called, {
          ...base,
          assistantMessageID,
          callID,
          tool: "edit",
          input,
          provider,
        })
      })
    const fail = (assistantMessageID: SessionMessage.ID) =>
      Effect.gen(function* () {
        yield* call(assistantMessageID, "failure")
        return yield* events.publish(SessionEvent.Tool.Failed, {
          ...base,
          assistantMessageID,
          callID: "failure",
          provider,
          error: {
            type: "unknown",
            message: "Old string not found",
            metadata: { phase: "mutation", reason: "match-failed" },
          },
        })
      })
    const success = (assistantMessageID: SessionMessage.ID) =>
      Effect.gen(function* () {
        yield* call(assistantMessageID, "success")
        return yield* events.publish(SessionEvent.Tool.Success, {
          ...base,
          assistantMessageID,
          callID: "success",
          provider,
          structured: { title: "updated" },
          content: [],
        })
      })
    const end = (assistantMessageID: SessionMessage.ID, finish = "stop") =>
      events.publish(SessionEvent.Step.Ended, {
        ...base,
        assistantMessageID,
        finish,
        ...usage,
      })
    const reports = () => transcript.filter((event) => event.type === SessionEvent.Tool.Disposition.type)
    return { events, database, transcript, messages, tool, prompt, start, fail, success, end, reports }
  })
}

describe("persisted tool failure dispositions", () => {
  for (const settlement of [undefined, "interrupted"] as const) {
    it.effect("uses host interruption provenance: " + String(settlement), () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* f.prompt()
        const publisher = createLLMEventPublisher(f.events, {
          sessionID,
          model,
          agent: "build",
          inputSequence: 0,
          contextEpoch: 0,
        })
        yield* publisher.publish(LLMEvent.toolCall({ id: "failure", name: "edit", input }))
        const assistantMessageID = yield* publisher.startAssistant()
        yield* publisher.failUnsettledTools("Tool execution interrupted", false, settlement)
        yield* f.events.publish(SessionEvent.Step.Ended, {
          ...base,
          ...usage,
          assistantMessageID,
          finish: "interrupted",
          termination: { category: "interrupted", source: "user", message: "Stopped by user" },
        })
        const tool = yield* f.tool(assistantMessageID)
        expect(tool.settlement).toBe(settlement)
        expect(tool.failureDisposition).toMatchObject({ status: settlement ? "interrupted" : "failed" })
        expect(tool.state).toMatchObject({ status: "error", error: { message: "Tool execution interrupted" } })
      }),
    )
  }

  it.effect("derives recovery after the terminal boundary without changing the original error", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const turn = yield* f.prompt()
      const assistant = yield* f.start()
      const failed = yield* f.fail(assistant)
      const original = yield* f.tool(assistant)
      expect(original.failureDisposition).toMatchObject({ status: "unknown", basisSeq: failed.durable?.seq })
      const success = yield* f.success(assistant)
      expect(f.reports()).toHaveLength(0)
      const ended = yield* f.end(assistant)
      const result = yield* f.tool(assistant)
      expect(result.state).toEqual(original.state)
      expect(result.time).toEqual(original.time)
      expect(result.settledSeq).toBe(failed.durable?.seq)
      expect(result.failureDisposition).toEqual({
        version: 1,
        sessionID,
        turnID: turn,
        assistantMessageID: assistant,
        callID: "failure",
        basisSeq: ended.durable?.seq,
        status: "recovered",
        reason: "same-operation",
        evidence: { assistantMessageID: assistant, callID: "success", settledSeq: success.durable?.seq },
      })
      expect(f.reports()).toHaveLength(1)
      // Nested report notification can precede its source notification. Ordered consumers use seq.
      const memory: SessionMessageUpdater.MemoryState = { messages: [] }
      for (const event of [...f.transcript].sort((a, b) => (a.durable?.seq ?? 0) - (b.durable?.seq ?? 0))) {
        yield* SessionMessageUpdater.update(SessionMessageUpdater.memory(memory), event)
      }
      expect(memory.messages).toEqual(yield* f.messages())
      const before = f.reports().length
      const rows = yield* f.database.db.select().from(EventTable).orderBy(asc(EventTable.seq)).all().pipe(Effect.orDie)
      yield* f.events.replayAll(
        rows.map((row) => ({
          id: row.id,
          type: row.type,
          seq: row.seq,
          aggregateID: row.aggregate_id,
          data: row.data,
        })),
        { publish: true },
      )
      expect(f.reports()).toHaveLength(before)
      expect(yield* f.database.db.select().from(EventTable).all().pipe(Effect.orDie)).toHaveLength(rows.length)
    }),
  )

  it.effect("keeps another turn unchanged and rejects a report computed before invalidation", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.prompt()
      const first = yield* f.start()
      yield* f.fail(first)
      yield* f.success(first)
      yield* f.end(first)
      const saved = SessionToolDisposition.read((yield* f.tool(first)).failureDisposition)!
      yield* f.prompt("An unrelated new request")
      const second = yield* f.start()
      yield* f.fail(second)
      yield* f.end(second)
      expect((yield* f.tool(first)).failureDisposition).toEqual(saved)
      expect((yield* f.tool(second)).failureDisposition).toMatchObject({ status: "failed" })
      const start = yield* f.events.publish(SessionEvent.Tool.Input.Started, {
        ...base,
        assistantMessageID: first,
        callID: "new-pending",
        name: "edit",
      })
      yield* f.events.publish(SessionEvent.Tool.Disposition, { ...base, reports: [saved] })
      expect((yield* f.tool(first)).failureDisposition).toMatchObject({
        status: "unknown",
        basisSeq: start.durable?.seq,
      })
      expect((yield* f.tool(second)).failureDisposition).toMatchObject({ status: "failed" })
    }),
  )

  it.effect("rolls back failed reports while retaining the committed source and unknown projection", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.prompt()
      const assistant = yield* f.start()
      yield* f.fail(assistant)
      yield* f.success(assistant)
      const ended = yield* Effect.gen(function* () {
        yield* f.events.project(SessionEvent.Tool.Disposition, () => Effect.die("report write rejected"))
        return yield* f.end(assistant)
      }).pipe(Effect.scoped)
      expect((yield* f.tool(assistant)).failureDisposition).toMatchObject({
        status: "unknown",
        basisSeq: ended.durable?.seq,
      })
      expect(f.reports()).toHaveLength(0)
      const stored = yield* f.database.db.select().from(EventTable).all().pipe(Effect.orDie)
      expect(stored.some((event) => event.id === ended.id)).toBe(true)
      expect(stored.some((event) => event.type.startsWith(SessionEvent.Tool.Disposition.type))).toBe(false)
      yield* f.events.publish(SessionEvent.Text.Started, { ...base, assistantMessageID: assistant, textID: "late" })
      yield* f.events.publish(SessionEvent.Text.Ended, {
        ...base,
        assistantMessageID: assistant,
        textID: "late",
        text: "Done",
      })
      expect((yield* f.tool(assistant)).failureDisposition).toMatchObject({ status: "recovered" })
    }),
  )

  it.effect("rolls back source invalidation together with a rejected source event", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.prompt()
      const assistant = yield* f.start()
      yield* f.fail(assistant)
      yield* f.success(assistant)
      yield* f.end(assistant)
      const before = yield* f.messages()
      yield* f.events.project(SessionEvent.Tool.Input.Started, () => Effect.die("source write rejected"))
      const result = yield* f.events
        .publish(SessionEvent.Tool.Input.Started, {
          ...base,
          assistantMessageID: assistant,
          callID: "rollback",
          name: "edit",
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(yield* f.messages()).toEqual(before)
      expect(f.reports()).toHaveLength(1)
    }),
  )

  it.effect("invalidates retained failures when revert removes their recovery evidence", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.prompt()
      const first = yield* f.start()
      yield* f.fail(first)
      yield* f.end(first, "tool-calls")
      const second = yield* f.start()
      yield* f.success(second)
      yield* f.end(second)
      expect((yield* f.tool(first)).failureDisposition).toMatchObject({ status: "recovered" })
      yield* f.events.publish(SessionEvent.RevertEvent.Staged, { ...base, revert: { messageID: first, files: [] } })
      expect((yield* f.tool(first)).failureDisposition).toMatchObject({ status: "unknown" })
      yield* f.events.publish(SessionEvent.RevertEvent.Committed, { ...base, messageID: first })
      expect((yield* f.messages()).some((message) => message.id === second)).toBe(false)
      expect((yield* f.tool(first)).failureDisposition).toMatchObject({ status: "unknown" })
      yield* f.end(first)
      expect((yield* f.tool(first)).failureDisposition).toMatchObject({ status: "failed" })
    }),
  )
})
