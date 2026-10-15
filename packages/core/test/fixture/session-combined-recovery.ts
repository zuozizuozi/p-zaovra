import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { LayerNode } from "../../src/effect/layer-node"
import { Database } from "../../src/database/database"
import { EventV2 } from "../../src/event"
import { SessionV2 } from "../../src/session"
import { SessionExecution } from "../../src/session/execution"
import { SessionExecutionLocal } from "../../src/session/execution/local"
import { SessionOutputRecovery } from "../../src/session/output-recovery"
import { AbsolutePath } from "../../src/schema"
import { ModelV2 } from "../../src/model"
import { ProviderV2 } from "../../src/provider"

const phase = process.argv[2]
const directory = AbsolutePath.make(path.resolve(process.argv[3]))
const sessionID = SessionV2.ID.make("ses_combined_recovery")

await Effect.runPromise(
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const database = yield* Database.Service
    if (phase === "before") {
      yield* session.create({
        id: sessionID,
        location: { directory },
        model: { id: ModelV2.ID.make("audit-model"), providerID: ProviderV2.ID.make("audit") },
      })
      yield* session.prompt({
        sessionID,
        prompt: {
          text: "ORIGINAL_REQUIREMENT: append once. LATEST_CONSTRAINT: preserve BOM; never repeat the append.",
        },
        resume: false,
      })
      // Public resumes are explicit: partial/error recovery must not become an automatic crash retry.
      const partial = yield* session.resume(sessionID).pipe(Effect.result)
      const retried = yield* session.resume(sessionID).pipe(Effect.result)
      const compacted = yield* session.compact({ sessionID })
      const recovery = yield* SessionOutputRecovery.read(database.db, sessionID)
      const state = {
        partial: partial._tag,
        retried: retried._tag,
        compacted,
        context: yield* session.context(sessionID),
        usage: yield* session.usage(sessionID),
        history: yield* session.history({ sessionID, limit: 1000 }),
        attempts: [...recovery.attempts],
      }
      yield* Effect.promise(() => Bun.write(path.join(directory, "before.json"), JSON.stringify(state)))
      // compact() has returned after durable publication; no database finalizers are allowed here.
      process.kill(process.pid, "SIGKILL")
      yield* Effect.never
    }
    const recovery = yield* SessionOutputRecovery.read(database.db, sessionID)
    const before = {
      context: yield* session.context(sessionID),
      usage: yield* session.usage(sessionID),
      history: yield* session.history({ sessionID, limit: 1000 }),
      attempts: [...recovery.attempts],
      active: Array.from(yield* session.active),
    }
    if (phase === "resume") yield* session.resume(sessionID)
    const after = {
      before,
      context: yield* session.context(sessionID),
      usage: yield* session.usage(sessionID),
    }
    yield* Effect.promise(() => Bun.write(path.join(directory, `${phase}.json`), JSON.stringify(after)))
  }).pipe(
    Effect.timeout("45 seconds"),
    Effect.scoped,
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([SessionV2.node, EventV2.node, Database.node]), [
        [Database.node, Database.layerFromPath(path.join(directory, "sessions.db"))],
        [SessionExecution.node, SessionExecutionLocal.node],
      ]),
    ),
  ),
)
