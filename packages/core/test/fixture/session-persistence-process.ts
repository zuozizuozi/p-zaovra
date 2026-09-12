import path from "node:path"
import { Deferred, Effect } from "effect"
import { EventV2 } from "../../src/event"
import { LayerNode } from "../../src/effect/layer-node"
import { AppNodeBuilder } from "../../src/effect/app-node-builder"
import { Database } from "../../src/database/database"
import { SessionV2 } from "../../src/session"
import { SessionExecution } from "../../src/session/execution"
import { SessionExecutionLocal } from "../../src/session/execution/local"
import { SessionMessage } from "../../src/session/message"
import { SessionHistory } from "../../src/session/history"
import { AbsolutePath } from "../../src/schema"
import { ModelV2 } from "../../src/model"
import { ProviderV2 } from "../../src/provider"

const phase = process.argv[2]
const directory = AbsolutePath.make(path.resolve(process.argv[3]))
const sessionID = SessionV2.ID.make("ses_disk_recovery")
const messageID = SessionMessage.ID.make("msg_disk_pending")
const cancelledID = SessionMessage.ID.make("msg_disk_cancelled")
const input = {
  sessionID,
  id: messageID,
  prompt: { text: "durable queued input" },
  delivery: "queue" as const,
  resume: false,
}

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    if (phase === "admit") {
      yield* session.create({
        id: sessionID,
        location: { directory },
        model: { id: ModelV2.ID.make("audit-model"), providerID: ProviderV2.ID.make("audit") },
      })
      yield* session.update({ sessionID, title: "Persistent recovery session" })
      const admitted = yield* session.prompt(input)
      yield* session.prompt({ ...input, id: cancelledID, prompt: { text: "cancelled queued input" } })
      const cancelled = yield* session.cancelInput({ sessionID, messageID: cancelledID })
      const result = { admitted, cancelled, pending: yield* session.pendingInputs(sessionID) }
      if (process.argv[4] === "crash") {
        yield* Effect.promise(() => Bun.write(path.join(directory, `${phase}.json`), JSON.stringify(result)))
        // Stop this fixture before layer/database finalizers to exercise committed WAL recovery.
        process.kill(process.pid, "SIGKILL")
        yield* Effect.never
      }
      return result
    }
    if (phase === "execute") {
      yield* session.resume(sessionID)
      return { context: yield* session.context(sessionID), pending: yield* session.pendingInputs(sessionID) }
    }
    if (phase === "execute-crash") {
      const events = yield* EventV2.Service
      const delta = yield* Deferred.make<void>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === "session.next.text.delta" && JSON.stringify(event.data).includes("PARTIAL_RESPONSE")
          ? Deferred.succeed(delta, undefined).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(delta).pipe(Effect.timeout("5 seconds"))
      const context = yield* session.context(sessionID)
      const database = yield* Database.Service
      const durableContext = yield* SessionHistory.load(database.db, sessionID)
      yield* Effect.promise(() =>
        Bun.write(path.join(directory, `${phase}.json`), JSON.stringify({ context, durableContext, streamed: true })),
      )
      process.kill(process.pid, "SIGKILL")
      yield* Effect.never
    }
    if (phase === "verify-crash") {
      return { context: yield* session.context(sessionID), active: Array.from(yield* session.active) }
    }
    if (phase === "verify") {
      const retry = yield* session.prompt(input)
      return {
        retry,
        context: yield* session.context(sessionID),
        pending: yield* session.pendingInputs(sessionID),
        active: Array.from(yield* session.active),
      }
    }
    if (phase !== "reconcile") return yield* Effect.die("Unknown persistence test phase")
    const adopted = yield* session.create({ id: sessionID, location: { directory } })
    const retried = yield* session.prompt(input)
    const cancelled = yield* session.prompt({ ...input, id: cancelledID, prompt: { text: "cancelled queued input" } })
    const conflict = yield* session.prompt({ ...input, prompt: { text: "conflicting retry" } }).pipe(Effect.result)
    return {
      adopted,
      retried,
      cancelled,
      conflict,
      pending: yield* session.pendingInputs(sessionID),
      active: Array.from(yield* session.active),
    }
  }).pipe(
    Effect.timeout("20 seconds"),
    Effect.scoped,
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([SessionV2.node, EventV2.node, Database.node]), [
        [Database.node, Database.layerFromPath(path.join(directory, "sessions.db"))],
        [SessionExecution.node, SessionExecutionLocal.node],
      ]),
    ),
  ),
)
await Bun.write(path.join(directory, `${phase}.json`), JSON.stringify(result))
