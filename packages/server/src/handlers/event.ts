import { EventV2 } from "@zaovra-ai/core/event"
import { ZaovraEvent } from "@zaovra-ai/protocol/groups/event"
import { Effect, Option, Schema, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"

const subscriberCapacity = 256

export function eventData(data: unknown): Sse.Event {
  const encoded = Schema.encodeUnknownSync(ZaovraEvent)(data)
  return {
    _tag: "Event",
    event: "message",
    id: encoded.id,
    data: JSON.stringify(encoded),
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const lastEventID = request.headers["last-event-id"]
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          data: {},
        }
        const output = Stream.unwrap(
          Effect.gen(function* () {
            // Acquiring the bounded stream installs its listener before readiness is observable.
            const live = yield* EventV2.allBounded(events, subscriberCapacity)
            const replay = events.recentAfter(
              lastEventID ? Option.getOrUndefined(Schema.decodeUnknownOption(EventV2.ID)(lastEventID)) : undefined,
            )
            const seen = new Set<string>()
            return Stream.make(connected).pipe(
              Stream.concat(replay.complete ? Stream.fromIterable(replay.events).pipe(Stream.concat(live)) : live),
              Stream.filter((event) => {
                if (seen.has(event.id)) return false
                seen.add(event.id)
                return true
              }),
            )
          }),
        ).pipe(Stream.map(eventData), Stream.pipeThroughChannel(Sse.encode()))
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
