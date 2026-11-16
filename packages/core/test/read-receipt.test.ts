import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { LLMEvent } from "@zaovra-ai/llm"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer, Scope } from "effect"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import receiptMigration from "../src/database/migration/20261116061652_read-receipt"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { EventTable } from "../src/event/sql"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { ModelV2 } from "../src/model"
import { PermissionV2 } from "../src/permission"
import { ProviderV2 } from "../src/provider"
import { ReadPin } from "../src/read-pin"
import { ReadReceiptTable } from "../src/read-receipt.sql"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { createLLMEventPublisher } from "../src/session/runner/publish-llm-event"
import { ReadTool } from "../src/tool/read"
import { ReadToolFileSystem } from "../src/tool/read-filesystem"
import { ToolRegistry } from "../src/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { toolIdentity } from "./lib/tool"

const windows = process.platform === "win32" && process.arch === "x64" ? test : test.skip
const model = { id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") }
const setup = Effect.gen(function* () {
  const sessions = yield* SessionV2.Service
  const here = yield* Location.Service
  const events = yield* EventV2.Service
  const database = yield* Database.Service
  const registry = yield* ToolRegistry.Service
  const captured = yield* registry.materialize()
  const session = yield* sessions.create({ model, location: { directory: here.directory } })
  const publisher = createLLMEventPublisher(events, {
    sessionID: session.id,
    agent: toolIdentity.agent,
    model,
    inputSequence: 0,
    contextEpoch: 0,
  })
  const call = (input: { path: string; limit?: number }, providerExecuted = false) =>
    Effect.gen(function* () {
      const event = LLMEvent.toolCall({ id: randomUUID(), name: "read", input, providerExecuted })
      yield* publisher.publish(event)
      const assistantMessageID = yield* publisher.assistantMessageID(event.id)
      const settlement = yield* captured.settle({
        sessionID: session.id,
        assistantMessageID,
        agent: toolIdentity.agent,
        call: event,
      })
      return { event, settlement, assistantMessageID }
    })
  const success = (value: Effect.Success<ReturnType<typeof call>>, clone = false) =>
    publisher.publish(
      LLMEvent.toolResult({
        id: value.event.id,
        name: "read",
        result: value.settlement.result,
        output: clone ? structuredClone(value.settlement.output) : value.settlement.output,
      }),
    )
  const receipts = () => database.db.select().from(ReadReceiptTable).all().pipe(Effect.orDie)
  return { call, success, receipts, database, session, publisher }
})

type State = {
  pin?: ReadPin.Pin
  reads: number
  actions: string[]
  unsupported: boolean
  assert: (input: PermissionV2.AssertInput) => Effect.Effect<void, PermissionV2.BlockedError>
  file: string
}

async function withRead(
  body: (h: Effect.Success<typeof setup>, state: State) => Effect.Effect<void, unknown, Scope.Scope>,
) {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, "project")
  await mkdir(directory)
  const state: State = {
    reads: 0,
    actions: [],
    unsupported: false,
    assert: () => Effect.void,
    file: path.join(tmp.path, "external.txt"),
  }
  await writeFile(state.file, "original source")
  const reader = Layer.effect(
    ReadToolFileSystem.Service,
    Effect.gen(function* () {
      const original = yield* ReadToolFileSystem.Service
      return ReadToolFileSystem.Service.of({
        ...original,
        pin: (file) =>
          state.unsupported
            ? Effect.succeed(undefined)
            : original.pin(file).pipe(
                Effect.map((pin) => {
                  state.pin = pin
                  return (
                    pin && {
                      ...pin,
                      read: (size) => {
                        state.reads++
                        return pin.read(size)
                      },
                    }
                  )
                }),
              ),
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(ReadToolFileSystem.node)))
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* body(yield* setup, state)
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            ReadTool.node,
            Database.node,
            EventV2.node,
            SessionV2.node,
            Location.node,
            ToolRegistry.node,
          ]),
          [
            [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(directory) }))],
            [
              Global.node,
              Global.layerWith({
                data: path.join(tmp.path, "data"),
                config: path.join(tmp.path, "config"),
                state: path.join(tmp.path, "state"),
              }),
            ],
            [SessionExecution.node, SessionExecution.noopLayer],
            [ReadToolFileSystem.node, reader],
            [
              Config.node,
              Layer.succeed(
                Config.Service,
                Config.Service.of({
                  entries: () =>
                    Effect.succeed([
                      new Config.Document({ type: "document", info: new Config.Info({ memory: { enabled: false } }) }),
                    ]),
                }),
              ),
            ],
            [
              PermissionV2.node,
              Layer.succeed(
                PermissionV2.Service,
                PermissionV2.Service.of({
                  assert: (input) =>
                    Effect.sync(() => {
                      state.actions.push(input.action)
                    }).pipe(Effect.andThen(Effect.suspend(() => state.assert(input)))),
                  ask: () => Effect.die("unused"),
                  reply: () => Effect.die("unused"),
                  get: () => Effect.die("unused"),
                  forSession: () => Effect.die("unused"),
                  list: () => Effect.die("unused"),
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

for (const action of ["external_directory", "read"])
  windows(`Read holds the original object before ${action} permission and commits only with success`, () =>
    withRead((h, state) =>
      Effect.gen(function* () {
        state.assert = (input) =>
          Effect.gen(function* () {
            expect(state.pin).toBeDefined()
            expect(state.reads).toBe(0)
            if (input.action !== action) return
            yield* Effect.promise(async () => {
              await rename(state.file, state.file + ".held")
              await writeFile(state.file, "replacement")
            })
          })
        const called = yield* h.call({ path: state.file })
        expect(called.settlement.output?.structured).toMatchObject({ content: "original source", encoding: "utf8" })
        expect(state.actions).toEqual(["external_directory", "read"])
        expect(() => state.pin!.read(1)).toThrow("closed")
        expect(yield* h.receipts()).toEqual([])
        yield* h.success(called)
        const rows = yield* h.receipts()
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          session_id: h.session.id,
          assistant_message_id: called.assistantMessageID,
          call_id: called.event.id,
          digest: createHash("sha256").update("original source").digest("hex"),
          bytes: 15,
          volume_id: state.pin!.identity.volume,
          file_id: state.pin!.identity.file,
          path: state.file,
        })
        expect(rows[0]!.success_seq).toBeGreaterThan(rows[0]!.called_seq)
      }),
    ),
  )

for (const action of ["external_directory", "read"])
  windows(`denial at ${action} releases the held object without reading or a receipt`, () =>
    withRead((h, state) =>
      Effect.gen(function* () {
        state.assert = (input) =>
          input.action === action ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void
        const called = yield* h.call({ path: state.file })
        expect(called.settlement.result.type).toBe("error")
        expect(state.reads).toBe(0)
        expect(() => state.pin!.read(1)).toThrow("closed")
        yield* h.success(called)
        expect(yield* h.receipts()).toEqual([])
      }),
    ),
  )

windows("cancellation during permission releases the held object", () =>
  withRead((h, state) =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>()
      state.assert = () => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))
      const fiber = yield* h.call({ path: state.file }).pipe(Effect.forkChild)
      yield* Deferred.await(waiting)
      yield* Fiber.interrupt(fiber)
      expect(state.reads).toBe(0)
      expect(() => state.pin!.read(1)).toThrow("closed")
      expect(yield* h.receipts()).toEqual([])
    }),
  ),
)

for (const mode of ["unsupported", "page", "clone", "provider"] as const)
  windows(`${mode} output cannot create a complete builtin receipt`, () =>
    withRead((h, state) =>
      Effect.gen(function* () {
        state.unsupported = mode === "unsupported"
        const called = yield* h.call(
          { path: state.file, ...(mode === "page" ? { limit: 1 } : {}) },
          mode === "provider",
        )
        expect(called.settlement.result.type).not.toBe("error")
        yield* h.success(called, mode === "clone")
        expect(yield* h.receipts()).toEqual([])
      }),
    ),
  )

for (const mode of ["directory", "image", "bounded"] as const)
  windows(`${mode} read has no complete-text receipt`, () =>
    withRead((h, state) =>
      Effect.gen(function* () {
        const target = mode === "directory" ? path.dirname(state.file) : state.file
        if (mode === "image")
          yield* Effect.promise(() => writeFile(state.file, Buffer.from("GIF89a\u0001\u0000\u0001\u0000")))
        // Raw file is under Read's 50 KiB cap; serialized metadata pushes the
        // provider-facing output over the registry's separate 50 KiB bound.
        if (mode === "bounded") yield* Effect.promise(() => writeFile(state.file, "x".repeat(51199)))
        const called = yield* h.call({ path: target })
        expect(called.settlement.result.type).not.toBe("error")
        if (mode === "bounded") expect(called.settlement.outputPaths?.length).toBeGreaterThan(0)
        yield* h.success(called)
        expect(yield* h.receipts()).toEqual([])
      }),
    ),
  )

windows("a serialized receipt lookalike and a changed original structure do not authorize registration", () =>
  withRead((h, state) =>
    Effect.gen(function* () {
      const called = yield* h.call({ path: state.file })
      const output = called.settlement.output!
      expect(output.structured).toBeObject()
      Object.assign(output.structured!, { content: "forged text", receipt: { digest: "forged", complete: true } })
      yield* h.success(called)
      expect(yield* h.receipts()).toEqual([])
    }),
  ),
)

windows("outer transaction rollback removes both the success event and receipt", () =>
  withRead((h, state) =>
    Effect.gen(function* () {
      const called = yield* h.call({ path: state.file })
      const before = yield* h.database.db.select().from(EventTable).all()
      let staged = false
      const result = yield* h.database.db
        .transaction(() =>
          h.success(called).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                expect(yield* h.receipts()).toHaveLength(1)
                staged = true
                return yield* Effect.fail("rollback fixture")
              }),
            ),
          ),
        )
        .pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(staged).toBe(true)
      expect(yield* h.receipts()).toEqual([])
      expect(yield* h.database.db.select().from(EventTable).all()).toHaveLength(before.length)
    }),
  ),
)

test("upgrading an existing database preserves history and does not invent old read receipts", () =>
  withRead((h, state) =>
    Effect.gen(function* () {
      state.unsupported = true
      const called = yield* h.call({ path: state.file })
      yield* h.success(called)
      const before = yield* h.database.db.select().from(EventTable).all()
      const sessions = yield* h.database.db.all(sql`SELECT * FROM session`)
      // Recreate the pre-receipt schema with real session/tool history retained.
      yield* h.database.db.run(sql`DROP TABLE read_receipt`)
      yield* h.database.db.run(sql`DELETE FROM migration WHERE id = ${receiptMigration.id}`)
      yield* DatabaseMigration.apply(h.database.db)
      yield* DatabaseMigration.apply(h.database.db)
      expect(yield* h.receipts()).toEqual([])
      expect(yield* h.database.db.select().from(EventTable).all()).toEqual(before)
      expect(yield* h.database.db.all(sql`SELECT * FROM session`)).toEqual(sessions)
    }),
  ))
