import { Cause, DateTime, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { EventV2 } from "../../event"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const events = yield* EventV2.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        if (session.time.archived) return
        const started = yield* DateTime.now
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) => reportFailure(store, events, session, started, cause)),
        )
      }),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      exclusive: coordinator.exclusive,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wait: coordinator.wait,
      compact: Effect.fn("SessionExecution.compact")(function* (sessionID) {
        let compacted = false
        yield* coordinator.exclusive(
          sessionID,
          Effect.gen(function* () {
            // Resolve placement only after admission: queued work must not retain a stale Location.
            const session = yield* store.get(sessionID)
            if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
            compacted = yield* SessionRunner.Service.use((runner) => runner.compact(sessionID)).pipe(
              Effect.provide(locations.get(session.location)),
            )
          }),
        )
        return compacted
      }),
      wake: coordinator.wake,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, EventV2.node],
})

export const reportFailure = Effect.fn("SessionExecution.reportFailure")(function* (
  store: SessionStore.Interface,
  events: EventV2.Interface,
  session: SessionSchema.Info,
  started: DateTime.Utc,
  cause: Cause.Cause<unknown>,
) {
  if (Cause.hasInterruptsOnly(cause)) return
  const ref = `err_${randomUUID()}`
  yield* Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID: session.id, ref }))
  const messages = yield* store.context(session.id).pipe(Effect.catch(() => Effect.succeed([])))
  const latest = messages.flatMap((message) => (message.type === "assistant" ? [message] : [])).at(-1)
  // Provider failures already have a durable event. Do not duplicate them.
  if (
    latest?.error &&
    latest.time.completed &&
    DateTime.toEpochMillis(latest.time.completed) >= DateTime.toEpochMillis(started)
  )
    return
  const error = Cause.squash(cause)
  // Unanticipated exceptions can contain secrets or complete payloads. Expose a
  // safe category, never arbitrary exception text; the reference locates the log.
  const reason =
    error instanceof RangeError
      ? "输入或媒体处理超过运行时限制（RangeError）"
      : error instanceof TypeError
        ? "执行过程中出现程序状态异常（TypeError）"
        : "执行过程中出现未预期错误"
  const timestamp = yield* DateTime.now
  const model = session.model ?? latest?.model
  if (!model) {
    yield* events.publish(SessionEvent.Synthetic, {
      sessionID: session.id,
      timestamp,
      messageID: SessionMessage.ID.create(),
      text: `${reason}。尚无可用模型记录，执行未完成。ref=${ref}`,
    })
    return
  }
  const assistantMessageID = latest && !latest.time.completed ? latest.id : SessionMessage.ID.create()
  if (!latest || latest.time.completed)
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID: session.id,
      timestamp,
      assistantMessageID,
      agent: session.agent ?? latest?.agent ?? "build",
      model,
    })
  yield* events.publish(SessionEvent.Step.Failed, {
    sessionID: session.id,
    timestamp,
    assistantMessageID,
    error: { type: "unknown", message: `${reason}。本次执行已停止，原始记录保留。ref=${ref}`, metadata: { ref } },
  })
})

export * as SessionExecutionLocal from "./local"
