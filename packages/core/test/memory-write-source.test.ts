import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { DateTime, Effect, Layer, Scope } from "effect"
import { Memory } from "@zaovra-ai/schema/memory"
import { Config } from "../src/config"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { MemoryStore } from "../src/memory/store"
import { MemoryTidyStore } from "../src/memory/tidy-store"
import { ModelV2 } from "../src/model"
import { Catalog } from "../src/catalog"
import { ModelMemoryProfile } from "../src/model-memory-profile"
import { MemoryWritePolicy } from "../src/memory/write-policy"
import { ProviderV2 } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { MemoryTool } from "../src/tool/memory"
import { ToolRegistry } from "../src/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { toolIdentity } from "./lib/tool"

import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { MemoryRecorder } from "../src/memory/recorder"
import { SessionEvent } from "../src/session/event"
import { SessionMessage } from "../src/session/message"

const model = { id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") }
const setup = Effect.gen(function* () {
  const sessions = yield* SessionV2.Service
  const store = yield* MemoryStore.Service
  const events = yield* EventV2.Service
  const here = yield* Location.Service
  const registry = yield* ToolRegistry.Service
  const catalog = yield* Catalog.Service
  const writing = yield* MemoryWritePolicy.Service
  yield* catalog.transform((draft) => {
    draft.provider.update(model.providerID, (provider) => {
      provider.integrationID = undefined
    })
    draft.model.update(model.providerID, model.id, (entry) => {
      entry.enabled = true
      entry.capabilities.tools = true
      // Deliberately untrusted declaration: only the host fixture profile can allow it.
      entry.capabilities.memoryNote = true
    })
  })
  const captured = yield* registry.materialize()
  const project = yield* store.scope({ project: here.project.id, directory: here.directory })
  const create = (parentID?: SessionV2.ID) =>
    sessions.create({ parentID, model, location: { directory: here.directory } })
  const call = (
    sessionID: SessionV2.ID,
    input: Record<string, unknown>,
    name = "memory_note",
    callID: string = randomUUID(),
    author: ModelV2.Ref = model,
  ) =>
    Effect.gen(function* () {
      const context = { sessionID, assistantMessageID: SessionMessage.ID.create(), agent: toolIdentity.agent }
      const timestamp = yield* DateTime.now
      yield* events.publish(SessionEvent.Step.Started, { ...context, timestamp, model: author })
      yield* events.publish(SessionEvent.Tool.Input.Started, { ...context, timestamp, callID, name })
      const source = yield* events.publish(SessionEvent.Tool.Called, {
        ...context,
        timestamp,
        callID,
        tool: name,
        input,
        provider: { executed: false },
      })
      return {
        context,
        source,
        invocation: { ...context, call: { type: "tool-call" as const, id: callID, name, input } },
      }
    })
  return { sessions, store, events, captured, project, create, call, catalog, writing }
})

test("main memory_note resolves its durable source and remains unverified; user edits stay authoritative", () =>
  withMemory(
    (h) =>
      Effect.gen(function* () {
        const main = yield* h.create()
        const input = { kind: "decision", text: "Keep the local fixture offline", basis: "user approved", seq: 999999 }
        const called = yield* h.call(main.id, input)
        expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({ kept: true })
        const notes = yield* h.store.list(h.project)
        expect(notes).toHaveLength(1)
        expect(notes[0]).toMatchObject({
          origin: "model",
          status: "unverified",
          sessionID: main.id,
          seq: called.source.durable?.seq,
        })
        expect(notes[0].seq).toBeGreaterThan(0)
        expect(notes[0].seq).not.toBe(999999)
        yield* h.store.edit(notes[0].id, { text: "User correction stays authoritative" })
        expect((yield* h.store.get(notes[0].id))?.text).toBe("User correction stays authoritative")
      }),
    true,
  ))

test("unknown profile refuses a catalog self-declaration without preventing search", () =>
  withMemory((h) =>
    Effect.gen(function* () {
      const session = yield* h.create()
      expect((yield* h.catalog.model.get(model.providerID, model.id))?.capabilities.memoryNote).toBeUndefined()
      expect(yield* h.writing.allowed(session.id)).toBe(false)
      const call = yield* h.call(session.id, { kind: "decision", text: "Untrusted catalog claim" })
      expect((yield* h.captured.settle(call.invocation)).output?.structured).toMatchObject({ kept: false })
      expect(yield* h.store.list(h.project)).toEqual([])
      expect(h.captured.definitions.some((item) => item.name === "memory_search")).toBe(true)
    }),
  ))

for (const change of ["disabled", "off", "tools", "provider", "model", "variant"] as const)
  test(`captured memory leaf rechecks ${change} at admission`, () =>
    withMemory(
      (h, settings) =>
        Effect.gen(function* () {
          const session = yield* h.create()
          const call = yield* h.call(session.id, { kind: "decision", text: "Only the evaluated author may write" })
          expect(yield* h.writing.allowed(session.id)).toBe(true)
          if (change === "disabled") settings.enabled = false
          if (change === "off" || change === "tools")
            yield* h.catalog.transform((draft) =>
              draft.model.update(model.providerID, model.id, (entry) => {
                if (change === "off") entry.memoryNote = "off"
                if (change === "tools") entry.capabilities.tools = false
              }),
            )
          if (change === "provider")
            yield* h.catalog.transform((draft) =>
              draft.provider.update(model.providerID, (entry) => {
                entry.disabled = true
              }),
            )
          if (change === "model")
            yield* h.sessions.switchModel({
              sessionID: session.id,
              model: { ...model, id: ModelV2.ID.make("unknown") },
            })
          if (change === "variant")
            yield* h.sessions.switchModel({
              sessionID: session.id,
              model: { ...model, variant: ModelV2.VariantID.make("other") },
            })
          expect((yield* h.captured.settle(call.invocation)).output?.structured).toMatchObject({ kept: false })
          expect(yield* h.store.list(h.project)).toEqual([])
        }),
      true,
    ))

test("switching an unknown author's session to a reliable model cannot launder its old call", () =>
  withMemory(
    (h) =>
      Effect.gen(function* () {
        const session = yield* h.create()
        const unknown = { ...model, id: ModelV2.ID.make("unknown") }
        yield* h.sessions.switchModel({ sessionID: session.id, model: unknown })
        const call = yield* h.call(
          session.id,
          { kind: "decision", text: "Original author must match" },
          "memory_note",
          randomUUID(),
          unknown,
        )
        yield* h.sessions.switchModel({ sessionID: session.id, model })
        expect(yield* h.writing.allowed(session.id)).toBe(true)
        expect((yield* h.captured.settle(call.invocation)).output?.structured).toMatchObject({ kept: false })
        expect(yield* h.store.list(h.project)).toEqual([])
      }),
    true,
  ))

test("another session's unknown model does not unregister the reliable session's memory tool", () =>
  withMemory(
    (h) =>
      Effect.gen(function* () {
        const reliable = yield* h.create()
        const unknown = yield* h.create()
        yield* h.sessions.switchModel({ sessionID: unknown.id, model: { ...model, id: ModelV2.ID.make("unknown") } })
        expect(yield* h.writing.allowed(reliable.id)).toBe(true)
        expect(yield* h.writing.allowed(unknown.id)).toBe(false)
        const call = yield* h.call(reliable.id, { kind: "decision", text: "Isolated reliable session" })
        expect((yield* h.captured.settle(call.invocation)).output?.structured).toMatchObject({ kept: true })
        expect(yield* h.store.list(h.project)).toHaveLength(1)
      }),
    true,
  ))

for (const mismatch of ["missing", "call", "assistant", "session", "tool", "input"] as const)
  test(`memory_note rejects ${mismatch} provenance without writing`, () =>
    withMemory((h) =>
      Effect.gen(function* () {
        const main = yield* h.create()
        const other = yield* h.create()
        const input = { kind: "decision", text: "A durable call must own this note" }
        if (mismatch === "missing") {
          const result = yield* h.captured.settle({
            sessionID: main.id,
            ...toolIdentity,
            call: { type: "tool-call", id: randomUUID(), name: "memory_note", input },
          })
          expect(result.output?.structured).toMatchObject({ kept: false })
          expect(yield* h.store.list(h.project)).toEqual([])
          return
        }
        const called = yield* h.call(main.id, input, mismatch === "tool" ? "memory_search" : "memory_note")
        const invocation = {
          ...called.invocation,
          ...(mismatch === "session" ? { sessionID: other.id } : {}),
          ...(mismatch === "assistant" ? { assistantMessageID: SessionMessage.ID.create() } : {}),
          call: {
            ...called.invocation.call,
            name: "memory_note",
            ...(mismatch === "call" ? { id: randomUUID() } : {}),
            ...(mismatch === "input" ? { input: { ...input, text: "different note" } } : {}),
          },
        }
        expect((yield* h.captured.settle(invocation)).output?.structured).toMatchObject({ kept: false })
        expect(yield* h.store.list(h.project)).toEqual([])
      }),
    ))

test("a real child session cannot save notes but can search and return evidence to its parent", () =>
  withMemory((h) =>
    Effect.gen(function* () {
      const main = yield* h.create()
      const child = yield* h.create(main.id)
      const manual = yield* h.store.write({
        scope: h.project,
        kind: "decision",
        text: "Manual offline fixture note",
        origin: "user",
        status: "verified",
      })
      expect(manual).toBeDefined()
      const called = yield* h.call(child.id, { kind: "decision", text: "Child must suggest this to parent" })
      expect((yield* h.captured.settle(called.invocation)).output?.structured).toMatchObject({
        kept: false,
        reason: expect.stringContaining("parent"),
      })
      const search = yield* h.captured.settle({
        ...called.context,
        call: { type: "tool-call", id: randomUUID(), name: "memory_search", input: { query: "offline fixture" } },
      })
      expect(search.result.type).not.toBe("error")
      expect(JSON.stringify(search.output?.structured)).toContain("Manual offline fixture note")
      expect(yield* h.store.list(h.project)).toHaveLength(1)
      if (!manual) throw new Error("manual fixture missing")
      expect(manual.seq).toBeUndefined()
      yield* h.store.edit(manual.id, { text: "Manual correction" })
      expect((yield* h.store.get(manual.id))?.text).toBe("Manual correction")
    }),
  ))

test("Recorder ignores child success and correlates identical call IDs by session and assistant", () =>
  withMemory((h) =>
    Effect.gen(function* () {
      const main = yield* h.create()
      const child = yield* h.create(main.id)
      const childUnique = yield* h.call(child.id, { command: "bun build" }, "bash", "child-only")
      const parentCall = yield* h.call(main.id, { command: "bun typecheck" }, "bash", "shared")
      const childCall = yield* h.call(child.id, { command: "bun test" }, "bash", "shared")
      const sameSessionCall = yield* h.call(main.id, { command: "bun lint" }, "bash", "shared")
      for (const called of [childUnique, childCall, sameSessionCall, parentCall])
        yield* h.events.publish(SessionEvent.Tool.Success, {
          ...called.context,
          timestamp: yield* DateTime.now,
          callID: called.invocation.call.id,
          provider: { executed: false },
          structured: { exit: 0, truncated: false },
          content: [],
        })
      // Success subscribers process in order. The parent typecheck is the last barrier.
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((yield* h.store.list(h.project)).some((note) => note.text === "typecheck: `bun typecheck`")) break
        yield* Effect.sleep("10 millis")
      }
      const notes = yield* h.store.list(h.project)
      expect(notes.some((note) => note.text === "typecheck: `bun typecheck`" && note.sessionID === main.id)).toBe(true)
      expect(notes.some((note) => note.sessionID === child.id || note.text.includes("bun test"))).toBe(false)
    }),
  ))

async function withMemory(
  body: (h: Effect.Success<typeof setup>, settings: { enabled: boolean }) => Effect.Effect<void, unknown, Scope.Scope>,
  evaluated = false,
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
            Catalog.node,
            MemoryWritePolicy.node,
            MemoryTool.node,
            MemoryRecorder.node,
            Database.node,
            EventV2.node,
            MemoryStore.node,
            MemoryTidyStore.node,
            SessionV2.node,
            Location.node,
            ToolRegistry.node,
          ]),
          [
            [
              ModelMemoryProfile.node,
              Layer.succeed(
                ModelMemoryProfile.Service,
                ModelMemoryProfile.Service.of({
                  memoryNote: (entry, variant) =>
                    evaluated && entry.providerID === model.providerID && entry.id === model.id && variant === undefined
                      ? true
                      : undefined,
                }),
              ),
            ],
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
