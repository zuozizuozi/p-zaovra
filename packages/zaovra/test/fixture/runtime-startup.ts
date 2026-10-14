import "../preload"
import { afterAll, expect } from "bun:test"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { AppLayer, AppRuntime } from "../../src/effect/app-runtime"
import { SessionRuntime } from "../../src/effect/session-runtime"
import { Server } from "../../src/server/server"
import { LocationServiceMap } from "@zaovra-ai/core/location-services"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { EventV2Bridge } from "../../src/event-v2-bridge"

if (process.env.ZAOVRA_TEST_STARTUP_ORDER === "runtime-first") await AppRuntime.runPromise(Effect.void)
else {
  // Desktop sidecar starts a real listener, whose memo map differs from the
  // process-wide in-memory handler. Keep that owner alive during the suite.
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  afterAll(() => listener.stop(true))
  expect((await fetch(new URL("/global/health", listener.url))).ok).toBe(true)
}

await (async () => {
  const first = Scope.makeUnsafe()
  const second = Scope.makeUnsafe()
  try {
    const a = await Effect.runPromise(Layer.buildWithMemoMap(AppLayer, Layer.makeMemoMapUnsafe(), first))
    const b = await Effect.runPromise(Layer.buildWithMemoMap(SessionRuntime.layer, Layer.makeMemoMapUnsafe(), second))
    const execution = await AppRuntime.runPromise(SessionExecution.Service)
    const locations = await AppRuntime.runPromise(LocationServiceMap.Service)
    const events = await AppRuntime.runPromise(EventV2Bridge.Service)
    expect(Context.get(a, SessionExecution.Service)).toBe(execution)
    expect(Context.get(b, SessionExecution.Service)).toBe(execution)
    expect(Context.get(a, LocationServiceMap.Service)).toBe(locations)
    expect(Context.get(b, LocationServiceMap.Service)).toBe(locations)
    expect(Context.get(b, EventV2Bridge.Service)).toBe(events)
    await Effect.runPromise(Scope.close(first, Exit.void))
    expect(await AppRuntime.runPromise(SessionExecution.Service)).toBe(execution)
    expect((await Effect.runPromise(Context.get(b, SessionExecution.Service).active)).size).toBe(0)
  } finally {
    await Effect.runPromise(Scope.close(first, Exit.void))
    await Effect.runPromise(Scope.close(second, Exit.void))
  }
})()
console.log("shared-runtime-identity-ok")
