import path from "node:path"
import { Effect } from "effect"
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
const phase = process.argv[3]
const id = SessionV2.ID.make("ses_alias_restart")
await Effect.runPromise(
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const events = yield* EventV2.Service
    const snapshot = Effect.gen(function* () {
      return {
        context: yield* sessions.context(id),
        usage: yield* sessions.usage(id),
        history: yield* sessions.history({ sessionID: id, limit: 1000 }),
        active: [...(yield* sessions.active)],
      }
    })
    if (phase === "seed") {
      yield* sessions.create({
        id,
        location: { directory },
        model: { id: ModelV2.ID.make("friendly"), providerID: ProviderV2.ID.make("audit") },
      })
      yield* sessions.prompt({
        sessionID: id,
        prompt: { text: "ORIGINAL_REQUIREMENT append exactly once; retain tool evidence" },
        resume: false,
      })
      yield* sessions.resume(id)
    }
    if (phase === "partial") {
      yield* sessions.prompt({
        sessionID: id,
        prompt: { text: "LATEST_CONSTRAINT preserve BOM; continue without replaying the completed append" },
        resume: false,
      })
      yield* sessions.resume(id)
    }
    if (phase === "commit") {
      const unsubscribe = yield* events.listen((event) => {
        if (
          event.type !== "session.next.compaction.ended" ||
          !event.data ||
          typeof event.data !== "object" ||
          !("sessionID" in event.data) ||
          event.data.sessionID !== id
        )
          return Effect.void
        return Effect.gen(function* () {
          const state = yield* snapshot
          yield* Effect.promise(() => Bun.write(path.join(directory, "commit.json"), JSON.stringify(state)))
          process.kill(process.pid, "SIGKILL")
          yield* Effect.never
        }).pipe(Effect.orDie)
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* sessions.resume(id)
    }
    if (phase === "resume") yield* sessions.resume(id)
    const state = yield* snapshot
    yield* Effect.promise(() => Bun.write(path.join(directory, `${phase}.json`), JSON.stringify(state)))
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
