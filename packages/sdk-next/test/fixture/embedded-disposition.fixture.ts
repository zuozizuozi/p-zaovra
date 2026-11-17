import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@zaovra-ai/core/flag/flag"
import { Effect, Fiber, Latch, Option, Stream } from "effect"

test("embedded host persists real failed-read recovery through its ordinary router", async () => {
  const directory = await mkdtemp(join(tmpdir(), "embedded-disposition-"))
  const database = Flag.ZAOVRA_DB
  Flag.ZAOVRA_DB = join(directory, "embedded.sqlite")
  const target = join(directory, "result.txt")
  const calls: unknown[] = []
  const summary = `## Objective
- Create result.txt and verify it
## Important Details
- Original read failed because the path was absent; preserve that failure
## Work State
### Completed
- Wrote result.txt and read back verified fixture
### Active
- Await the next request
### Blocked
- (none)
## Next Move
1. Report the previous verification if asked
## Relevant Files
- result.txt: verified fixture`
  // Only the upstream is scripted: real tools, admission, runner, live listeners,
  // SQLite projections and generated embedded client all use the ordinary host.
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls.push(await request.json())
      const step = calls.length
      const tool =
        step <= 3
          ? {
              name: step === 2 ? "write" : "read",
              input: step === 2 ? { path: target, content: "verified fixture\n" } : { path: target },
            }
          : undefined
      const chunk = (delta: object, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: "embedded-disposition", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      return new Response(
        chunk({
          role: "assistant",
          ...(tool
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${step}`,
                    type: "function",
                    function: { name: tool.name, arguments: JSON.stringify(tool.input) },
                  },
                ],
              }
            : { content: step === 5 ? summary : "Created result.txt and verified its contents." }),
        }) +
          chunk({}, tool ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    await Bun.write(
      join(directory, "zaovra.json"),
      JSON.stringify({
        memory: { enabled: false },
        // Explicitly exercise manual compaction without a large artificial
        // transcript. The production serializer and router remain unchanged.
        compaction: { auto: false, keep: { tokens: 0 } },
        permission: { "*": "allow" },
        experimental: { verification: false, delivery_contract: false },
        provider: {
          "embedded-fixture": {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "offline-fixture" },
            models: { fixture: { limit: { context: 32000, output: 1024 } } },
          },
        },
      }),
    )
    const { AbsolutePath, Location, Model, Provider, Prompt, Zaovra } = await import("../../src")
    const saved = await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* Zaovra.create()
        const session = yield* host.sessions.create({
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
          model: Model.Ref.make({ id: Model.ID.make("fixture"), providerID: Provider.ID.make("embedded-fixture") }),
        })
        const connected = yield* Latch.make(false)
        const globalReport = yield* host.events.subscribe().pipe(
          Stream.tap((event) => (event.type === "server.connected" ? connected.open : Effect.void)),
          Stream.filter(
            (event) =>
              event.type === "session.next.tool.disposition" &&
              event.data.sessionID === session.id &&
              event.data.reports.some((item) => item.callID === "call-1" && item.status === "recovered"),
          ),
          Stream.runHead,
          Effect.timeout("25 seconds"),
          Effect.map(Option.getOrThrow),
          Effect.forkScoped,
        )
        yield* connected.await.pipe(Effect.timeout("4 seconds"))
        const admission = yield* host.sessions.prompt({
          sessionID: session.id,
          prompt: Prompt.make({
            text: "Read result.txt; if absent create it, then read it to verify.",
            runPolicy: { mode: "unattended", deadline: Date.now() + 20_000, closingReserveMs: 2000 },
          }),
        })
        const report = yield* host.sessions.events({ sessionID: session.id }).pipe(
          Stream.filter(
            (event) =>
              event.type === "session.next.tool.disposition" &&
              event.data.reports.some((item) => item.callID === "call-1" && item.status === "recovered"),
          ),
          Stream.runHead,
          Effect.timeout("25 seconds"),
          Effect.map(Option.getOrThrow),
        )
        const context = yield* host.sessions.context({ sessionID: session.id })
        const failed = context
          .flatMap((message) =>
            message.type === "assistant"
              ? message.content.filter((part) => part.type === "tool" && part.id === "call-1")
              : [],
          )
          .at(0)
        expect(failed?.type).toBe("tool")
        if (failed?.type !== "tool") throw new Error("Missing original failed read")
        expect(failed.state.status).toBe("error")
        if (failed.state.status !== "error") throw new Error("Original failure was overwritten")
        expect(failed.state.error.metadata).toMatchObject({ readFailure: "not_found" })
        expect(failed.failureDisposition).toMatchObject({
          sessionID: session.id,
          turnID: admission.id,
          callID: "call-1",
          status: "recovered",
        })
        expect(report.type).toBe("session.next.tool.disposition")
        if (report.type !== "session.next.tool.disposition") throw new Error("Missing durable recovery report")
        expect(yield* Fiber.join(globalReport)).toEqual({
          ...report,
          location: { directory: AbsolutePath.make(directory) },
        })
        const history = yield* host.sessions.history({ sessionID: session.id, limit: 100 })
        expect(history.data.some((event) => event.type === "session.next.tool.disposition")).toBe(true)
        expect(calls).toHaveLength(4)
        expect(JSON.stringify(calls)).not.toContain('"failureDisposition"')
        expect(JSON.stringify(calls)).not.toContain('"settledSeq"')
        expect(yield* Effect.promise(() => Bun.file(target).text())).toBe("verified fixture\n")
        yield* host.sessions.interrupt({ sessionID: session.id })
        return { sessionID: session.id, failed, history: history.data }
      }).pipe(Effect.scoped),
    )
    // A new embedded lifetime reads saved projections without restarting a model.
    const compacted = await Effect.runPromise(
      Effect.gen(function* () {
        const reopened = yield* Zaovra.create()
        const context = yield* reopened.sessions.context({ sessionID: saved.sessionID })
        const failed = context
          .flatMap((message) =>
            message.type === "assistant"
              ? message.content.filter((part) => part.type === "tool" && part.id === "call-1")
              : [],
          )
          .at(0)
        expect(failed).toEqual(saved.failed)
        expect((yield* reopened.sessions.history({ sessionID: saved.sessionID, limit: 100 })).data).toEqual(
          saved.history,
        )
        expect(calls).toHaveLength(4)
        const original = context.find(
          (message) =>
            message.type === "assistant" &&
            message.content.some((part) => part.type === "tool" && part.id === "call-1"),
        )
        if (original?.type !== "assistant" || failed?.type !== "tool" || failed.state.status !== "error")
          throw new Error("Missing saved original failure")
        expect(yield* reopened.sessions.compact({ sessionID: saved.sessionID })).toEqual({ compacted: true })
        expect(calls).toHaveLength(5)
        expect(JSON.stringify(calls.at(4))).toContain(
          JSON.stringify(`[Tool error]: ${failed.state.error.message}`).slice(1, -1),
        )
        expect(JSON.stringify(calls.at(4))).not.toContain("failureDisposition")
        expect(JSON.stringify(calls.at(4))).not.toContain("settledSeq")
        const compactedContext = yield* reopened.sessions.context({ sessionID: saved.sessionID })
        expect(compactedContext.some((message) => message.type === "compaction" && message.summary === summary)).toBe(
          true,
        )
        expect(compactedContext.some((message) => message.id === original.id)).toBe(false)
        // The fresh runner refreshes system context before compacting. That
        // committed source legitimately recalculates the report's basis, while
        // the original error, evidence, status and all other fields must stay.
        const refreshed = (yield* reopened.sessions.history({ sessionID: saved.sessionID, limit: 100 })).data
          .slice(saved.history.length)
          .find((event) => event.type === "session.next.context.updated")
        const basisSeq = refreshed?.durable?.seq
        if (basisSeq === undefined) throw new Error("Missing fresh runner context update")
        const retained = yield* reopened.sessions.message({ sessionID: saved.sessionID, messageID: original.id })
        expect(retained).toEqual({
          ...original,
          content: original.content.map((part) =>
            part.type === "tool" && part.id === "call-1"
              ? { ...part, failureDisposition: { ...part.failureDisposition, basisSeq } }
              : part,
          ),
        })
        if (retained?.type !== "assistant") throw new Error("Original message was removed by compaction")
        yield* reopened.sessions.prompt({
          sessionID: saved.sessionID,
          prompt: Prompt.make({ text: "State the previous verification without calling tools." }),
        })
        yield* reopened.sessions.wait({ sessionID: saved.sessionID }).pipe(Effect.timeout("10 seconds"))
        expect(calls).toHaveLength(6)
        expect(JSON.stringify(calls.at(5))).toContain("Original read failed because the path was absent")
        expect(JSON.stringify(calls.at(5))).not.toContain("failureDisposition")
        expect(JSON.stringify(calls.at(5))).not.toContain("settledSeq")
        return {
          original: retained,
          context: yield* reopened.sessions.context({ sessionID: saved.sessionID }),
          history: (yield* reopened.sessions.history({ sessionID: saved.sessionID, limit: 100 })).data,
        }
      }).pipe(Effect.scoped),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const reopened = yield* Zaovra.create()
        expect(yield* reopened.sessions.context({ sessionID: saved.sessionID })).toEqual(compacted.context)
        expect((yield* reopened.sessions.history({ sessionID: saved.sessionID, limit: 100 })).data).toEqual(
          compacted.history,
        )
        expect(
          yield* reopened.sessions.message({ sessionID: saved.sessionID, messageID: compacted.original.id }),
        ).toEqual(compacted.original)
        expect(calls).toHaveLength(6)
      }).pipe(Effect.scoped),
    )
  } finally {
    await provider.stop(true)
    Flag.ZAOVRA_DB = database
    await rm(directory, { recursive: true, force: true })
  }
}, 40_000)
