import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionExecutionStatus } from "../src/session/execution-status"
import { SessionSchema } from "../src/session/schema"
import { Changed, Version } from "@zaovra-ai/schema/session-execution-status"

test("execution status uses the canonical public wire contract", () => {
  expect(SessionExecutionStatus.Changed).toBe(Changed)
  expect(SessionExecutionStatus.Version).toBe(Version)
})

test("execution readers require one scoped authority and cannot mutate its active set", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const status = yield* SessionExecutionStatus.Service
      const active = new Set([SessionSchema.ID.create()])
      expect(yield* status.active).toBeUndefined()
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* status.track(Effect.sync(() => active))
          expect([...(yield* status.active)!]).toEqual([...active])
          const copy = yield* status.active
          expect(copy).not.toBe(active)
          active.clear()
          expect([...(yield* status.active)!]).toEqual([])
          yield* Effect.scoped(
            status.track(Effect.succeed(new Set())).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  expect(yield* status.active).toBeUndefined()
                }),
              ),
            ),
          )
          expect([...(yield* status.active)!]).toEqual([])
        }),
      )
      expect(yield* status.active).toBeUndefined()
    }).pipe(Effect.provide(SessionExecutionStatus.layer)),
  )
})
