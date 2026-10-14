import { expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Credential } from "@zaovra-ai/core/credential"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { EventV2 } from "@zaovra-ai/core/event"
import { Integration } from "@zaovra-ai/core/integration"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventV2.node, Database.node])),
)

const fixture = Effect.fn(function* (refresh: Integration.OAuthImplementation["refresh"], name = "refresh-fixture") {
  const integrations = yield* Integration.Service
  const credentials = yield* Credential.Service
  const integrationID = Integration.ID.make(name)
  const methodID = Integration.MethodID.make("local-oauth")
  const implementation = {
    integrationID,
    method: { id: methodID, type: "oauth" as const, label: "Local OAuth" },
    authorize: () => Effect.die("Sign-in is not part of this test"),
    refresh,
  }
  yield* integrations.transform((editor) => editor.method.update(implementation))
  const saved = yield* credentials.create({
    integrationID,
    value: Credential.OAuth.make({ type: "oauth", methodID, access: "old", refresh: "old", expires: 0 }),
  })
  return { implementation, connection: { type: "credential" as const, id: saved.id, label: saved.label } }
})

function rotated(value: Credential.OAuth) {
  return Credential.OAuth.make({ ...value, access: "new", refresh: "rotated", expires: Date.now() + 3_600_000 })
}

it.live("joins refresh across Location registries and persists the rotation exactly once", () =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const database = yield* Database.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let calls = 0
    const input = yield* fixture((value) =>
      Effect.gen(function* () {
        calls += 1
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return rotated(value)
      }),
    )
    const other = Context.get(
      yield* Layer.buildWithScope(Layer.fresh(Integration.locationLayer), yield* Scope.Scope),
      Integration.Service,
    )
    expect(other).not.toBe(integrations)
    yield* other.transform((editor) => editor.method.update(input.implementation))
    yield* database.db.run("CREATE TEMP TABLE refresh_writes (id TEXT)")
    yield* database.db.run(
      "CREATE TEMP TRIGGER count_refresh AFTER UPDATE OF value ON credential BEGIN INSERT INTO refresh_writes VALUES (NEW.id); END",
    )
    const first = yield* integrations.connection.resolve(input.connection).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const second = yield* other.connection.resolve(input.connection).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* Deferred.succeed(release, undefined)
    const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
    expect(results).toEqual([expect.objectContaining({ access: "new" }), expect.objectContaining({ access: "new" })])
    expect((yield* credentials.get(input.connection.id))?.value).toMatchObject({ access: "new", refresh: "rotated" })
    expect(yield* database.db.all(sql`SELECT id FROM refresh_writes`)).toEqual([{ id: input.connection.id }])
    expect(yield* other.connection.resolve(input.connection)).toEqual(results[0])
    expect(calls).toBe(1)
  }),
)

it.live("shares a failed refresh and releases ownership for retry", () =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let calls = 0
    const input = yield* fixture((value) =>
      Effect.gen(function* () {
        calls += 1
        if (calls > 1) return rotated(value)
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return yield* Effect.fail("local refresh failure")
      }),
    )
    const first = yield* integrations.connection.resolve(input.connection).pipe(Effect.exit, Effect.forkScoped)
    yield* Deferred.await(entered)
    const second = yield* integrations.connection.resolve(input.connection).pipe(Effect.exit, Effect.forkScoped)
    yield* Effect.yieldNow
    yield* Deferred.succeed(release, undefined)
    const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
    expect(results.every(Exit.isFailure)).toBe(true)
    expect(calls).toBe(1)
    expect((yield* credentials.get(input.connection.id))?.value).toMatchObject({ access: "old", refresh: "old" })
    expect(yield* integrations.connection.resolve(input.connection)).toMatchObject({
      access: "new",
      refresh: "rotated",
    })
    expect(calls).toBe(2)
  }),
)

it.live("owner interruption releases all waiters and allows another refresh", () =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const entered = yield* Deferred.make<void>()
    let calls = 0
    const input = yield* fixture((value) =>
      Effect.gen(function* () {
        calls += 1
        if (calls > 1) return rotated(value)
        yield* Deferred.succeed(entered, undefined)
        return yield* Effect.never
      }),
    )
    const first = yield* integrations.connection.resolve(input.connection).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const second = yield* integrations.connection.resolve(input.connection).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(first)
    expect(Exit.isFailure(yield* Fiber.await(second))).toBe(true)
    expect(yield* integrations.connection.resolve(input.connection)).toMatchObject({ access: "new" })
    expect(calls).toBe(2)
  }),
)

it.live("cancelling a waiter does not cancel the refresh owner", () =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let calls = 0
    const input = yield* fixture((value) =>
      Effect.gen(function* () {
        calls += 1
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return rotated(value)
      }),
    )
    const first = yield* integrations.connection.resolve(input.connection).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const second = yield* integrations.connection.resolve(input.connection).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(second)
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(first)).toMatchObject({ access: "new" })
    expect(yield* integrations.connection.resolve(input.connection)).toMatchObject({ access: "new" })
    expect(calls).toBe(1)
  }),
)

it.live("different credential IDs refresh independently", () =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const firstInput = yield* fixture(
      (value) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(release)
          return rotated(value)
        }),
      "first-refresh",
    )
    const secondInput = yield* fixture((value) => Effect.succeed(rotated(value)), "second-refresh")
    const first = yield* integrations.connection.resolve(firstInput.connection).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    expect(yield* integrations.connection.resolve(secondInput.connection)).toMatchObject({ access: "new" })
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(first)).toMatchObject({ access: "new" })
  }),
)
