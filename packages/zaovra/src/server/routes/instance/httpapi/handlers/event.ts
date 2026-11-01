import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@zaovra-ai/core/event"
import { Effect, Option, Queue, Schema } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"

function eventData(data: { id: string; type: string; properties: unknown }): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: data.id,
    data: JSON.stringify(data),
  }
}

function eventID() {
  return EventV2.ID.create()
}

const subscriberCapacity = 256

export function instanceEventStream(
  events: Pick<EventV2.Interface, "listen" | "recentAfter">,
  input: { directory: string; workspaceID?: string },
  lastEventID?: string,
) {
  return Effect.gen(function* () {
    const queue = yield* Queue.dropping<EventV2.Payload, EventV2.SubscriberOverflowError>(subscriberCapacity)
    const matches = (event: EventV2.Payload) =>
      event.location?.directory === input.directory &&
      (event.location.workspaceID === undefined || event.location.workspaceID === input.workspaceID)
    const state = { unsubscribe: Effect.void, overflow: false }
    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        if (!matches(event) || state.overflow) return
        if (yield* Queue.offer(queue, event)) return
        state.overflow = true
        yield* state.unsubscribe
        yield* Queue.fail(queue, new EventV2.SubscriberOverflowError({ capacity: subscriberCapacity }))
      }),
    )
    state.unsubscribe = unsubscribe
    if (state.overflow) yield* unsubscribe
    yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.andThen(Queue.shutdown(queue))))
    const replay = events.recentAfter(
      lastEventID ? Option.getOrUndefined(Schema.decodeUnknownOption(EventV2.ID)(lastEventID)) : undefined,
    )
    const recent = replay.events.filter(matches)
    const complete = replay.complete && recent.length <= subscriberCapacity
    const seen = new Set<string>()
    return Stream.make({
      id: eventID(),
      type: "server.connected",
      properties: { replay: complete ? "applied" : lastEventID ? "reset" : "initial" },
    }).pipe(
      Stream.concat(
        (complete
          ? Stream.fromIterable(recent).pipe(Stream.concat(Stream.fromQueue(queue)))
          : Stream.fromQueue(queue)
        ).pipe(
          Stream.filter((event) => {
            if (seen.has(event.id)) return false
            seen.add(event.id)
            if (seen.size > subscriberCapacity * 2) seen.delete(seen.values().next().value!)
            return true
          }),
          Stream.map((event) => ({ id: event.id, type: event.type, properties: event.data })),
        ),
      ),
    )
  })
}

function eventResponse(events: EventV2.Interface, lastEventID?: string) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    const stream = yield* instanceEventStream(events, { directory: instance.directory, workspaceID }, lastEventID)
    const disposed = Stream.callback<{ id: string; type: string; properties: unknown }>(
      (queue) => {
        const listener = (event: {
          directory?: string
          payload: { id?: string; type?: string; properties?: unknown }
        }) => {
          if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
          Queue.offerUnsafe(queue, {
            id: event.payload.id ?? eventID(),
            type: "server.instance.disposed",
            properties: event.payload.properties ?? {},
          })
        }
        return Effect.acquireRelease(
          Effect.sync(() => GlobalBus.on("event", listener)),
          () => Effect.sync(() => GlobalBus.off("event", listener)),
        )
      },
      { bufferSize: 1, strategy: "dropping" },
    )
    const output = stream.pipe(
      Stream.merge(disposed, { haltStrategy: "left" }),
      Stream.takeUntil((event) => event.type === "server.instance.disposed"),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      output.pipe(
        Stream.merge(heartbeat, { haltStrategy: "left" }),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* eventResponse(events, request.headers["last-event-id"])
      }),
    )
  }),
)
