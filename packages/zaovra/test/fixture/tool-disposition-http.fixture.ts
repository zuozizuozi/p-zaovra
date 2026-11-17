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
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        yield* events.publish(SessionEvent.Prompted, {
          ...base,
          messageID: turnID,
          prompt: Prompt.make({ text: "Update main.ts" }),
          delivery: "steer",
        })
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
