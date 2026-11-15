import { expect, test } from "bun:test"
import path from "node:path"
import { DateTime, Effect, Layer, ManagedRuntime, Stream } from "effect"
import { Schema } from "effect"
import { LLMClient, LLMEvent, Model, type LLMRequest } from "@zaovra-ai/llm"
import { OpenAIChat } from "@zaovra-ai/llm/protocols/openai-chat"
import { Memory } from "@zaovra-ai/schema/memory"
import { Config } from "../src/config"
import { ConfigMemory } from "../src/config/memory"
import { ConfigV1 } from "../src/v1/config/config"
import { ConfigExperimental } from "../src/config/experimental"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { MemoryContext } from "../src/memory/context"
import { MemoryPages } from "../src/memory/pages"
import { MemoryPageTable } from "../src/memory/pages.sql"
import { MemoryStore } from "../src/memory/store"
import { MemoryTaskContext } from "../src/memory/task-context"
import { PluginV2 } from "../src/plugin"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionContextEpoch } from "../src/session/context-epoch"
import { SessionEvent } from "../src/session/event"
import { SessionExecution } from "../src/session/execution"
import { SessionInput } from "../src/session/input"
import { SessionMemoryContext } from "../src/session/memory-context"
import { SessionMessage } from "../src/session/message"
import { SessionRunner } from "../src/session/runner"
import { node } from "../src/session/runner/llm"
import { SessionRunnerModel } from "../src/session/runner/model"
import { Snapshot } from "../src/snapshot"
import { SystemContext } from "../src/system-context"
import { SystemContextRegistry } from "../src/system-context/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"

function runtime(directory: string, state: { enabled: boolean; taskSearch: boolean }, requests?: LLMRequest[]) {
  return ManagedRuntime.make(
    AppNodeBuilder.build(
      LayerNode.group([
        MemoryContext.node,
        MemoryTaskContext.node,
        MemoryStore.node,
        SystemContextRegistry.node,
        Location.node,
        SessionV2.node,
        Database.node,
        EventV2.node,
        ...(requests ? [node] : []),
      ]),
      [
        [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(directory) }))],
        [Database.node, Database.layerFromPath(path.join(directory, "task-memory.db"))],
        [
          Global.node,
          Global.layerWith({
            data: path.join(directory, "data"),
            config: path.join(directory, "config"),
            state: path.join(directory, "state"),
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
                    info: new Config.Info({
                      memory: { ...state },
                      experimental: new ConfigExperimental.Experimental({
                        verification: false,
                        delivery_contract: false,
                        quality_progress: { facts: false, stagnation_log: false },
                      }),
                    }),
                  }),
                ]),
            }),
          ),
        ],
        [PluginV2.node, Layer.mock(PluginV2.Service, { wait: () => Effect.void })],
        [Snapshot.node, Snapshot.noopLayer],
        [
          SessionRunnerModel.node,
          SessionRunnerModel.layerWith(() =>
            Effect.succeed(Model.make({ id: "offline", provider: "offline", route: OpenAIChat.route })),
          ),
        ],
        [
          LayerNodePlatform.llmClient,
          Layer.succeed(
            LLMClient.Service,
            LLMClient.Service.of({
              prepare: () => Effect.die("unused: scripted provider events"),
              generate: () => Effect.die("unused"),
              stream: (request) => {
                requests?.push(request)
                return Stream.fromIterable<LLMEvent>([
                  LLMEvent.stepStart({ index: 0 }),
                  LLMEvent.textStart({ id: "done" }),
                  LLMEvent.textDelta({ id: "done", text: "Fixture response complete." }),
                  LLMEvent.textEnd({ id: "done" }),
                  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
                  LLMEvent.finish({ reason: "stop" }),
                ])
              },
            }),
          ),
        ],
      ],
    ),
  )
}

const setup = Effect.gen(function* () {
  const sessions = yield* SessionV2.Service
  const store = yield* MemoryStore.Service
  const database = yield* Database.Service
  const events = yield* EventV2.Service
  const memory = yield* MemoryTaskContext.Service
  const registry = yield* SystemContextRegistry.Service
  const here = yield* Location.Service
  const scope = yield* store.scope({ project: here.project.id, directory: here.directory })
  const context = (id: SessionV2.ID) =>
    Effect.all([registry.load(), SessionMemoryContext.load(database.db, memory, id)]).pipe(
      Effect.map(SystemContext.combine),
    )
  const prepare = (id: SessionV2.ID) => SessionContextEpoch.prepare(database.db, events, context(id), id)
  const source = (id: SessionV2.ID) => SessionContextEpoch.sourceValue(database.db, id, MemoryTaskContext.key)
  const prompt = (id: SessionV2.ID, text: string) =>
    Effect.gen(function* () {
      yield* sessions.prompt({ sessionID: id, resume: false, prompt: { text } })
      yield* SessionInput.promoteSteers(database.db, events, id, yield* EventV2.latestSequence(database.db, id))
    })
  return { sessions, store, database, events, memory, here, scope, context, prepare, source, prompt }
})

test("task matches persist across turns and restart without refreshing the index or reading queued/host input", async () => {
  await using temp = await tmpdir()
  const state = { enabled: true, taskSearch: true }
  const first = runtime(temp.path, state)
  const saved = await first
    .runPromise(
      Effect.gen(function* () {
        const h = yield* setup
        const note = yield* h.store.write({
          scope: h.scope,
          kind: "practice",
          text: "sqlite migration original instructions",
          origin: "user",
          status: "verified",
        })
        if (!note) throw new Error("missing fixture note")
        const session = yield* h.sessions.create({ location: { directory: h.here.directory } })
        const before = yield* SessionContextEpoch.initialize(h.database.db, h.context(session.id), session.id)
        expect(before?.baseline).toContain("original instructions")
        yield* h.sessions.prompt({ sessionID: session.id, resume: false, prompt: { text: "sqlite migration" } })
        yield* h.prepare(session.id)
        expect(yield* h.source(session.id)).toBeUndefined()
        yield* SessionInput.promoteSteers(
          h.database.db,
          h.events,
          session.id,
          yield* EventV2.latestSequence(h.database.db, session.id),
        )
        expect(yield* h.prepare(session.id)).toEqual(before!)
        const source = yield* h.source(session.id)
        expect(JSON.stringify(source)).toContain("original instructions")
        yield* h.store.edit(note.id, { text: "sqlite schema updated instructions" })
        yield* h.prepare(session.id)
        expect(yield* h.source(session.id)).toEqual(source)
        yield* h.prompt(session.id, "继续")
        yield* h.prepare(session.id)
        expect(yield* h.source(session.id)).toEqual(source)
        yield* SessionInput.admit(h.database.db, h.events, {
          id: SessionMessage.ID.create(),
          sessionID: session.id,
          prompt: { text: "sqlite schema" },
          delivery: "queue",
        })
        yield* h.events.publish(SessionEvent.Synthetic, {
          sessionID: session.id,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          text: "sqlite schema background completed",
        })
        yield* h.prepare(session.id)
        expect(yield* h.source(session.id)).toEqual(source)
        const transcript = yield* h.sessions.context(session.id)
        expect(
          transcript.filter((message) => message.type === "system" && message.text.includes("memory-task-search")),
        ).toHaveLength(1)
        expect(
          transcript.filter((message) => message.type === "synthetic" && message.text.includes("memory-task-search")),
        ).toHaveLength(0)
        return { id: session.id, source, before }
      }),
    )
    .finally(() => first.dispose())
  const second = runtime(temp.path, state)
  await second
    .runPromise(
      Effect.gen(function* () {
        const h = yield* setup
        expect(yield* h.prepare(saved.id)).toEqual(saved.before!)
        expect(yield* h.source(saved.id)).toEqual(saved.source)
        yield* h.prompt(saved.id, "sqlite schema")
        yield* h.prepare(saved.id)
        const next = yield* h.source(saved.id)
        expect(JSON.stringify(next)).toContain("updated instructions")
        expect(next).not.toEqual(saved.source)
        expect((yield* h.prepare(saved.id)).baseline).toContain("original instructions")
        yield* h.events.publish(SessionEvent.Compaction.Ended, {
          sessionID: saved.id,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          reason: "manual",
          text: "summary",
          recent: "",
        })
        const compacted = yield* h.prepare(saved.id)
        expect(compacted.baseline).toContain("updated instructions")
        expect(compacted.baseline).not.toContain("original instructions")
        expect(yield* h.source(saved.id)).toEqual(next)
        state.taskSearch = false
        yield* h.prepare(saved.id)
        expect(yield* h.source(saved.id)).toBeUndefined()
        expect((yield* h.prepare(saved.id)).baselineSeq).toBe(compacted.baselineSeq)
        state.taskSearch = true
        yield* h.prepare(saved.id)
        expect(yield* h.source(saved.id)).toEqual(next)
        state.enabled = false
        yield* h.prepare(saved.id)
        expect(yield* h.source(saved.id)).toBeUndefined()
      }),
    )
    .finally(() => second.dispose())
})

test("task search ranks L1 and L2, labels unchecked notes, excludes other scopes and limits output", async () => {
  await using temp = await tmpdir()
  const app = runtime(temp.path, { enabled: true, taskSearch: true })
  await app
    .runPromise(
      Effect.gen(function* () {
        const h = yield* setup
        const note = yield* h.store.write({
          scope: h.scope,
          kind: "practice",
          text: "sqlite migration source",
          origin: "user",
          status: "verified",
        })
        if (!note) throw new Error("missing fixture note")
        yield* h.database.db
          .insert(MemoryPageTable)
          .values({
            id: Memory.PageID.make("mpg_task_fixture"),
            scope: h.scope,
            key: "fixture",
            title: "sqlite migration",
            summary: "A complete migration guide.",
            body: "sqlite migration",
            sources: [MemoryPages.source(note)],
            revision: "fixture",
            aliases: [],
          })
          .run()
          .pipe(Effect.orDie)
        yield* h.store.write({
          scope: Memory.Scope.user,
          kind: "decision",
          text: "sqlite migration unchecked hint",
          origin: "model",
          status: "unverified",
        })
        yield* h.store.write({
          scope: h.scope,
          kind: "pitfall",
          text: "sqlite migration " + "超".repeat(1000),
          origin: "user",
          status: "verified",
        })
        yield* h.store.write({
          scope: h.scope,
          kind: "convention",
          text: "sqlite migration fourth",
          origin: "user",
          status: "verified",
        })
        const elsewhere = yield* h.store.scope({
          project: h.here.project.id,
          directory: h.here.directory + "/elsewhere",
        })
        yield* h.store.write({
          scope: elsewhere,
          kind: "decision",
          text: "sqlite migration PRIVATE",
          origin: "user",
          status: "verified",
        })
        const generation = yield* SystemContext.initialize(
          yield* h.memory.load({ id: "task", text: "sqlite migration" }, undefined),
        )
        expect(generation.baseline).toContain("A complete migration guide.")
        expect(generation.baseline).toContain("unverified")
        expect(generation.baseline).not.toContain("PRIVATE")
        expect(generation.baseline).not.toContain("migration source")
        expect(generation.baseline.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(3)
        expect(Buffer.byteLength(generation.baseline)).toBeLessThan(3000)
      }),
    )
    .finally(() => app.dispose())
})

test("real runner attaches task search before the very first provider request", async () => {
  await using temp = await tmpdir()
  const requests: LLMRequest[] = []
  const app = runtime(temp.path, { enabled: true, taskSearch: true }, requests)
  await app
    .runPromise(
      Effect.gen(function* () {
        const h = yield* setup
        const observed = { count: 0 }
        const registry = yield* SystemContextRegistry.Service
        yield* registry.register({
          key: SystemContext.Key.make("test/task-observation"),
          load: Effect.succeed(
            SystemContext.make({
              key: SystemContext.Key.make("test/once"),
              codec: Schema.toCodecJson(Schema.String),
              load: Effect.sync(() => {
                observed.count++
                return "initial context"
              }),
              baseline: (value) => value,
              update: (_before, value) => value,
            }),
          ),
        })
        yield* h.store.write({
          scope: h.scope,
          kind: "practice",
          text: "sqlite migration first provider hint",
          origin: "model",
          status: "unverified",
        })
        const session = yield* h.sessions.create({ location: { directory: h.here.directory } })
        yield* h.sessions.prompt({ sessionID: session.id, resume: false, prompt: { text: "sqlite migration" } })
        const runner = yield* SessionRunner.Service
        yield* runner.run({ sessionID: session.id, force: true })
        expect(requests.length).toBeGreaterThan(0)
        expect(JSON.stringify(requests[0]!.messages)).toContain("first provider hint")
        expect(JSON.stringify(requests[0]!.messages)).toContain("unverified")
        expect(yield* h.source(session.id)).toBeDefined()
        expect(observed.count).toBe(1)
      }).pipe(Effect.scoped),
    )
    .finally(() => app.dispose())
})

test("memory index limits validate in both config generations and include wrapper UTF-8 bytes", () => {
  const memory = { enabled: true, taskSearch: false, index: { enabled: true, maxLines: 200, maxBytes: 25600 } }
  expect(Schema.decodeUnknownSync(Config.Info)({ memory }).memory).toEqual(memory)
  expect(Schema.decodeUnknownSync(ConfigV1.Info)({ memory }).memory).toEqual(memory)
  for (const index of [{ maxLines: 201 }, { maxLines: 7 }, { maxBytes: 25601 }, { maxBytes: 1023 }, { maxLines: 8.5 }])
    expect(() => Schema.decodeUnknownSync(ConfigMemory.Info)({ index })).toThrow()
  const lines = Array.from({ length: 240 }, (_, i) => `${i}: ${"中".repeat(30)}`)
  const larger = MemoryContext.render("Project memory", lines, { maxLines: 200, maxBytes: 25600 })
  expect(larger.split("\n").length).toBe(200)
  expect(Buffer.byteLength(larger)).toBeLessThanOrEqual(25600)
  const small = MemoryContext.render("Project memory", lines, { maxLines: 8, maxBytes: 1024 })
  expect(small.split("\n").length).toBeLessThanOrEqual(8)
  expect(Buffer.byteLength(small)).toBeLessThanOrEqual(1024)
  const normal = MemoryContext.render("Project memory", lines)
  expect(normal.split("\n").length).toBeLessThanOrEqual(60)
  expect(Buffer.byteLength(normal)).toBeLessThanOrEqual(4096)
})
