import "../preload"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Server } from "../../src/server/server"

// Keep the event bus alive while the listener's projector layer is released.
await AppRuntime.runPromise(Effect.void)
const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
await listener.stop(true)
console.log("work-listener-stopped")
