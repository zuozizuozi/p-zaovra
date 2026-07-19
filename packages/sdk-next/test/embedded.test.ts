import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@zaovra-ai/core/flag/flag"
import { Deferred, Effect, Latch, Option, Schema, Stream } from "effect"
import type { ZaovraEvent } from "../src"

test("embedded client uses the real router and handlers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zaovra-embedded-"))
  const database = Flag.ZAOVRA_DB
  Flag.ZAOVRA_DB = join(directory, "zaovra.sqlite")
  const { AbsolutePath, Agent, Location, Model, Zaovra, Prompt, Provider, Session, Tool } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)
  const model = Model.Ref.make({ id: Model.ID.make("embedded"), providerID: Provider.ID.make("test") })

  try {
    const program = Effect.gen(function* () {
      const zaovra = yield* Zaovra.create()
      yield* zaovra.tools.register({
        embedded_tool: Tool.make({
          description: "Embedded test tool",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
      })

      const created = yield* zaovra.sessions.create({
        id: sessionID,
        agent: Agent.ID.make("build"),
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* zaovra.sessions.switchModel({ sessionID, model })
      const selected = yield* zaovra.sessions.get({ sessionID })
      const page = yield* zaovra.sessions.list({ directory: AbsolutePath.make(directory) })
      const active = yield* zaovra.sessions.active()
      const admitted = yield* zaovra.sessions.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do not run" }),
        resume: false,
      })
      const context = yield* zaovra.sessions.context({ sessionID })
      const wake = yield* zaovra.sessions.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Promote this input" }),
      })
      const prompted = yield* zaovra.sessions.events({ sessionID }).pipe(
        Stream.filter((event) => event.type === "session.next.prompted" && event.data.messageID === wake.id),
        Stream.runHead,
        Effect.timeout("10 seconds"),
        Effect.map(Option.getOrThrow),
      )
      const wakeContext = yield* zaovra.sessions.context({ sessionID })
      const event = yield* zaovra.sessions
        .events({ sessionID })
        .pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrUndefined))
      const modelMessage = Option.fromNullishOr(context.find((message) => message.type === "model-switched")).pipe(
        Option.getOrThrow,
      )
      const message = yield* zaovra.sessions.message({ sessionID, messageID: modelMessage.id })
      yield* zaovra.sessions.interrupt({ sessionID })
      const other = yield* zaovra.sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      const missingSessionID = Session.ID.make(`ses_missing_${crypto.randomUUID()}`)
      const missing = yield* Effect.all(
        [
          zaovra.sessions.events({ sessionID: missingSessionID }).pipe(Stream.runHead, Effect.flip),
          zaovra.sessions.interrupt({ sessionID: missingSessionID }).pipe(Effect.flip),
          zaovra.sessions.message({ sessionID: missingSessionID, messageID: modelMessage.id }).pipe(Effect.flip),
        ],
        { concurrency: "unbounded" },
      )
      const missingMessage = yield* Effect.flip(
        zaovra.sessions.message({
          sessionID: other.id,
          messageID: modelMessage.id,
        }),
      )

      expect(created.id).toBe(sessionID)
      expect(selected.model?.id).toBe(model.id)
      expect(selected.model?.providerID).toBe(model.providerID)
      expect(page.data.some((session) => session.id === sessionID)).toBe(true)
      expect(active).toEqual({})
      expect(admitted.sessionID).toBe(sessionID)
      expect(prompted.type).toBe("session.next.prompted")
      expect(wakeContext).toContainEqual(expect.objectContaining({ id: wake.id, type: "user" }))
      expect(context.some((message) => message.type === "model-switched")).toBe(true)
      expect(event).toMatchObject({ type: "session.next.model.switched", durable: { seq: 1 } })
      expect(message).toEqual(modelMessage)
      expect(missing.map((error) => error._tag)).toEqual([
        "SessionNotFoundError",
        "SessionNotFoundError",
        "SessionNotFoundError",
      ])
      expect(missingMessage._tag).toBe("MessageNotFoundError")
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.ZAOVRA_DB = database
    await rm(directory, { recursive: true, force: true })
  }
})

test("Location-owned runner events reach the ready global client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zaovra-embedded-events-"))
  const database = Flag.ZAOVRA_DB
  Flag.ZAOVRA_DB = join(directory, "zaovra.sqlite")
  const { AbsolutePath, Location, Zaovra, Prompt, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const zaovra = yield* Zaovra.create()
      const connected = yield* Latch.make(false)
      const prompted = yield* Deferred.make<ZaovraEvent>()
      yield* zaovra.events.subscribe().pipe(
        Stream.runForEach((event) =>
          event.type === "server.connected"
            ? connected.open
            : event.type === "session.next.prompted" && event.data.sessionID === sessionID
              ? Deferred.succeed(prompted, event).pipe(Effect.asVoid)
              : Effect.void,
        ),
        Effect.forkScoped,
      )
      yield* connected.await
      yield* zaovra.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* zaovra.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Observe this input" }) })

      const event = yield* Deferred.await(prompted).pipe(Effect.timeout("4 seconds"))
      expect(event.durable).toEqual(expect.objectContaining({ aggregateID: sessionID, seq: expect.any(Number) }))
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.ZAOVRA_DB = database
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test("independent embedded hosts do not share live notifications", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zaovra-embedded-hosts-"))
  const database = Flag.ZAOVRA_DB
  Flag.ZAOVRA_DB = join(directory, "zaovra.sqlite")
  const { AbsolutePath, Agent, Location, Zaovra, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const first = yield* Zaovra.create()
      const second = yield* Zaovra.create()
      const firstReady = yield* Latch.make(false)
      const secondReady = yield* Latch.make(false)
      const firstEvent = yield* Latch.make(false)
      const secondEvent = yield* Latch.make(false)
      const observe = (ready: Latch.Latch, event: Latch.Latch) =>
        Stream.runForEach((notification: ZaovraEvent) =>
          notification.type === "server.connected"
            ? ready.open
            : notification.type === "session.next.agent.switched" && notification.data.sessionID === sessionID
              ? event.open
              : Effect.void,
        )

      yield* first.events.subscribe().pipe(observe(firstReady, firstEvent), Effect.forkScoped)
      yield* second.events.subscribe().pipe(observe(secondReady, secondEvent), Effect.forkScoped)
      yield* Effect.all([firstReady.await, secondReady.await], { discard: true })
      yield* first.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* first.sessions.switchAgent({ sessionID, agent: Agent.ID.make("plan") })

      yield* firstEvent.await.pipe(Effect.timeout("2 seconds"))
      expect(Option.isNone(yield* secondEvent.await.pipe(Effect.timeoutOption("100 millis")))).toBe(true)
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.ZAOVRA_DB = database
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test("embedded client is available as a Layer service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zaovra-embedded-layer-"))
  const database = Flag.ZAOVRA_DB
  Flag.ZAOVRA_DB = join(directory, "zaovra.sqlite")
  const { AbsolutePath, Location, Zaovra, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const zaovra = yield* Zaovra.Service
        return yield* zaovra.sessions.create({
          id: sessionID,
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })
      }).pipe(Effect.provide(Zaovra.layer), Effect.scoped),
    )

    expect(created.id).toBe(sessionID)
  } finally {
    Flag.ZAOVRA_DB = database
    await rm(directory, { recursive: true, force: true })
  }
})
