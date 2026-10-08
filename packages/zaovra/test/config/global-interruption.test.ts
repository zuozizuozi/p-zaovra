import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Config } from "../../src/config/config"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Config.node))

it.live("an interrupted configuration reader does not poison later reads", () =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    yield* config.getGlobal()
    for (let attempt = 0; attempt < 10; attempt++) {
      yield* config.invalidate()
      const reader = yield* config.getGlobal().pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(reader)
      const result = yield* config.getGlobal().pipe(Effect.exit)
      expect(result._tag).toBe("Success")
    }
  }),
)
