import path from "node:path"
import { Effect, Deferred, Fiber } from "effect"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "../../src/effect/layer-node"
import { SessionV2 } from "../../src/session"
import { SessionExecution } from "../../src/session/execution"
import { SessionExecutionLocal } from "../../src/session/execution/local"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { AbsolutePath } from "../../src/schema"
import { ModelV2 } from "../../src/model"
import { ProviderV2 } from "../../src/provider"

const directory = AbsolutePath.make(path.resolve(process.argv[2]))
const mode = process.argv[3]
await Effect.runPromise(
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const events = yield* EventV2.Service
    const barrier = yield* Deferred.make<void>()
    const id = SessionV2.ID.make("ses_stop_tail")
    const unsubscribe = yield* events.listen((event) => {
      if (!event.data || typeof event.data !== "object" || !("sessionID" in event.data) || event.data.sessionID !== id)
        return Effect.void
      const ready =
        mode === "tail-before-exit" || mode === "input-before-stop"
          ? event.type === "session.next.tool.progress" && JSON.stringify(event.data).includes("OLD_TAIL_中文🙂")
          : event.type === "session.next.tool.success" && "callID" in event.data && event.data.callID === "old-call"
      return ready ? Deferred.succeed(barrier, undefined).pipe(Effect.asVoid) : Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    yield* sessions.create({
      id,
      location: { directory },
      model: { id: ModelV2.ID.make("fixture"), providerID: ProviderV2.ID.make("audit") },
    })
    yield* sessions.prompt({
      sessionID: id,
      prompt: { text: "FIRST_TASK: execute the fixture and retain its output" },
      resume: false,
    })
    const old = yield* Effect.forkScoped(sessions.resume(id).pipe(Effect.exit))
    yield* Deferred.await(barrier)
    if (mode === "idle-stop") yield* Fiber.join(old)
    const stop = yield* Effect.forkScoped(sessions.interrupt(id))
    if (mode !== "input-before-stop") yield* Effect.yieldNow
    yield* sessions.prompt({
      sessionID: id,
      prompt: { text: "SECOND_TASK: execute new fixture without repeating old one" },
    })
    yield* Fiber.join(stop)
    yield* Fiber.join(old)
    const stoppedPending = yield* sessions.pendingInputs(id)
    if (mode === "input-before-stop") yield* sessions.resume(id)
    yield* sessions.wait(id)
    const context = yield* sessions.context(id)
    const active = [...(yield* sessions.active)]
    const pending = yield* sessions.pendingInputs(id)
    yield* Effect.promise(() =>
      Bun.write(path.join(directory, "result.json"), JSON.stringify({ context, active, pending, stoppedPending })),
    )
  }).pipe(
    Effect.timeout("40 seconds"),
    Effect.scoped,
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([SessionV2.node, EventV2.node, Database.node]), [
        [Database.node, Database.layerFromPath(path.join(directory, "sessions.db"))],
        [SessionExecution.node, SessionExecutionLocal.node],
      ]),
    ),
  ),
)
