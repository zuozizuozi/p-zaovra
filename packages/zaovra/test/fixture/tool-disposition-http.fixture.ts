import { expect, test } from "bun:test"
import path from "node:path"
import { DateTime, Effect, Schema } from "effect"
import { EventV2 } from "@zaovra-ai/core/event"
import { ModelV2 } from "@zaovra-ai/core/model"
import { ProviderV2 } from "@zaovra-ai/core/provider"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionEvent } from "@zaovra-ai/core/session/event"
import { Prompt } from "@zaovra-ai/core/session/prompt"
import { SessionToolDisposition } from "@zaovra-ai/schema/session-tool-disposition"
import { SessionExecutionStatus } from "@zaovra-ai/schema/session-execution-status"
import { ZaovraEvent } from "@zaovra-ai/protocol/groups/event"
import { createZaovraClient } from "@zaovra-ai/sdk/v2/client"
import { Server } from "../../src/server/server"
import { AppRuntime } from "../../src/effect/app-runtime"
import { disposeAllInstances } from "./fixture"

// Exercise the ordinary application owner; adding a projector test layer here would
// conceal a missing production registration. All model execution is deliberately absent.
test("production listener and generated SDK expose committed tool dispositions", async () => {
  const directory = process.env.ZAOVRA_SERVER_TEST_DIR
  if (!directory || !path.isAbsolute(directory)) throw new Error("Use isolated ZAOVRA_SERVER_TEST_DIR")
  await Bun.write(
    path.join(directory, "zaovra.json"),
    JSON.stringify({ formatter: false, lsp: false, memory: { enabled: false } }),
  )
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  try {
    const client = createZaovraClient({ baseUrl: listener.url.href, directory })
    const created = await client.v2.session.create({ location: { directory } }, { throwOnError: true })
    expect(created.response.status).toBe(200)
    const sessionID = SessionV2.ID.make(created.data.data.id)
    const assistantMessageID = SessionMessage.ID.create()
    const turnID = SessionMessage.ID.create()
    const base = { sessionID, timestamp: DateTime.makeUnsafe(100) }
    const provider = { executed: false }
    const input = { filePath: path.join(directory, "main.ts"), oldString: "before", newString: "after" }
    const error = {
      type: "unknown" as const,
      message: "Old string not found",
      metadata: { phase: "mutation", reason: "match-failed" },
    }
    const cursor = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const anchor = yield* events.publish(SessionEvent.Prompted, {
          ...base,
          messageID: turnID,
          prompt: Prompt.make({ text: "Update main.ts" }),
          delivery: "steer",
        })
        yield* events.publish(SessionEvent.QualityProgress, {
          ...base,
          category: "operation",
          details: { privateFixture: true },
        })
        yield* events.publish(SessionExecutionStatus.Changed, { sessionID, active: false, epoch: 1, revision: 1 })
        yield* events.publish(SessionEvent.Step.Started, {
          ...base,
          assistantMessageID,
          agent: "build",
          model: { id: ModelV2.ID.make("offline"), providerID: ProviderV2.ID.make("fixture") },
        })
        for (const callID of ["failure", "success"]) {
          yield* events.publish(SessionEvent.Tool.Input.Started, { ...base, assistantMessageID, callID, name: "edit" })
          yield* events.publish(SessionEvent.Tool.Called, {
            ...base,
            assistantMessageID,
            callID,
            tool: "edit",
            input,
            provider,
          })
          if (callID === "failure") {
            yield* events.publish(SessionEvent.Tool.Failed, { ...base, assistantMessageID, callID, provider, error })
            continue
          }
          yield* events.publish(SessionEvent.Tool.Success, {
            ...base,
            assistantMessageID,
            callID,
            provider,
            structured: { title: "updated" },
            content: [],
          })
        }
        yield* events.publish(SessionEvent.Step.Ended, {
          ...base,
          assistantMessageID,
          finish: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        return anchor.id
      }),
    )
    const messages = await client.v2.session.messages({ sessionID, order: "asc", limit: 100 }, { throwOnError: true })
    expect(messages.response.status).toBe(200)
    const assistant = messages.data.data.find((message) => message.id === assistantMessageID)
    if (assistant?.type !== "assistant") throw new Error("Missing projected assistant over HTTP")
    const failure = assistant.content.find((part) => part.type === "tool" && part.id === "failure")
    if (failure?.type !== "tool") throw new Error("Missing failed tool over HTTP")
    expect(assistant.turn).toBe(turnID)
    expect(failure.state).toMatchObject({ status: "error", error, input })
    const report = Schema.decodeUnknownSync(SessionToolDisposition.Info)(failure.failureDisposition)
    expect(report).toMatchObject({
      sessionID,
      turnID,
      assistantMessageID,
      callID: "failure",
      status: "recovered",
      reason: "same-operation",
    })
    expect(failure.settledSeq).toBeLessThan(report.basisSeq)
    const history = await client.v2.session.history({ sessionID, limit: 100 }, { throwOnError: true })
    expect(history.response.status).toBe(200)
    // Public history decodes storage's versioned type into type + durable metadata.
    const reports = history.data.data.filter((event) => event.type === SessionEvent.Tool.Disposition.type)
    expect(reports).toHaveLength(1)
    expect(reports[0].durable?.version).toBe(1)
    expect(reports[0].data).toMatchObject({ sessionID, reports: [report] })
    // Reconnect after an actual retained cursor. Every returned item must satisfy
    // the current public contract, even with a private diagnostic in that range.
    const cancel = new AbortController()
    const replayed: ZaovraEvent[] = []
    try {
      const replay = await client.v2.event.subscribe({
        headers: { "Last-Event-ID": cursor },
        signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(5000)]),
        sseMaxRetryAttempts: 0,
      })
      for await (const event of replay.stream) {
        const decoded = Schema.decodeUnknownSync(ZaovraEvent)(event)
        replayed.push(decoded)
        if (decoded.id === reports[0].id) break
      }
    } finally {
      cancel.abort()
    }
    expect(replayed[0]?.type).toBe("server.connected")
    expect(replayed.some((event) => event.type === "session.execution.status")).toBe(true)
    expect(replayed.at(-1)).toEqual(Schema.decodeUnknownSync(ZaovraEvent)(reports[0]))
    expect(new Set(replayed.map((event) => event.id)).size).toBe(replayed.length)
    expect(history.data.data.some((event) => event.type === "session.next.quality.progress")).toBe(true)
    // Reading through another ordinary listener must not publish another verdict.
    const second = await Server.listen({ hostname: "127.0.0.1", port: 0 })
    try {
      const other = createZaovraClient({ baseUrl: second.url.href, directory })
      const again = await other.v2.session.messages({ sessionID, order: "asc", limit: 100 }, { throwOnError: true })
      expect(again.data.data).toEqual(messages.data.data)
      const unchanged = await other.v2.session.history({ sessionID, limit: 100 }, { throwOnError: true })
      expect(unchanged.data.data).toEqual(history.data.data)
    } finally {
      await second.stop(true)
    }
  } finally {
    await listener.stop(true)
    await disposeAllInstances()
    await AppRuntime.dispose()
  }
}, 30000)
