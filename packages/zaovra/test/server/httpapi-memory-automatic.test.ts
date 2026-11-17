import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { MemoryAutomatic } from "@zaovra-ai/core/memory/automatic"
import { Server } from "../../src/server/server"
import { SessionRuntime } from "../../src/effect/session-runtime"
import { tmpdir } from "../fixture/fixture"

test("embedded HTTP entry wires automatic memory without granting consent or starting a task", async () => {
  await using tmp = await tmpdir({ git: true })
  for (let round = 0; round < 2; round++) {
    // A fresh host scope only: no service replacements or separately assembled test route tree.
    const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, runtime: SessionRuntime.create() })
    const query = new URLSearchParams({ "location[directory]": tmp.path })
    try {
      const response = await fetch(new URL(`/api/memory/automatic?${query}`, listener.url))
      expect(response.status, await response.clone().text()).toBe(200)
      expect(await response.json()).toEqual({ data: null })
      const tasks = await fetch(new URL(`/api/memory/tidy?${query}`, listener.url))
      expect(tasks.status, await tasks.clone().text()).toBe(200)
      expect(await tasks.json()).toEqual({ data: [] })
      const rejected = await fetch(new URL(`/api/memory/automatic/disable?${query}`, listener.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expected: "never-confirmed" }),
      })
      expect(rejected.status, await rejected.clone().text()).toBe(409)
      expect(await (await fetch(new URL(`/api/memory/automatic?${query}`, listener.url))).json()).toEqual({
        data: null,
      })
    } finally {
      await listener.stop(true)
    }
    await expect(
      fetch(new URL("/api/memory/automatic", listener.url), { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow()
  }
}, 30_000)

test("embedded startup runs the real automatic scheduler and releases it with the listener scope", async () => {
  const seen = { ticks: 0 }
  // Decorate the real implementation to observe lifecycle only; keep all original node dependencies.
  const observed = Layer.effect(
    MemoryAutomatic.Service,
    Effect.gen(function* () {
      const automatic = yield* MemoryAutomatic.Service
      return MemoryAutomatic.Service.of({
        ...automatic,
        tick: Effect.sync(() => seen.ticks++).pipe(Effect.andThen(automatic.tick)),
      })
    }),
  ).pipe(Layer.provide(MemoryAutomatic.layer))
  const runtime = SessionRuntime.create([[MemoryAutomatic.node, { ...MemoryAutomatic.node, implementation: observed }]])
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, runtime })
  try {
    for (const count of [1, 2]) {
      const deadline = Date.now() + 10_000
      while (seen.ticks < count && Date.now() < deadline) await Bun.sleep(20)
      expect(seen.ticks).toBeGreaterThanOrEqual(count)
    }
  } finally {
    await listener.stop(true)
  }
  const stopped = seen.ticks
  await Bun.sleep(5200)
  expect(seen.ticks).toBe(stopped)
}, 40_000)
