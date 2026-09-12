export * as SessionLive from "./live"

import { Context, Effect, Layer } from "effect"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"

export interface Interface {
  readonly capture: () => (messages: SessionMessage.Message[]) => SessionMessage.Message[]
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/v2/SessionLive") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const active = new Map<string, ReadonlyMap<string, string>>()
    const unsubscribe = yield* events.listen((payload) =>
      Effect.sync(() => {
        const event = payload as SessionEvent.Event
        switch (event.type) {
          case "session.next.text.started":
          case "session.next.reasoning.started":
          case "session.next.text.delta":
          case "session.next.reasoning.delta":
          case "session.next.text.ended":
          case "session.next.reasoning.ended": {
            const key = "textID" in event.data ? `text:${event.data.textID}` : `reasoning:${event.data.reasoningID}`
            const parts = new Map(active.get(event.data.assistantMessageID))
            parts.set(
              key,
              "delta" in event.data
                ? (parts.get(key) ?? "") + event.data.delta
                : "text" in event.data
                  ? event.data.text
                  : "",
            )
            active.set(event.data.assistantMessageID, parts)
            return
          }
          case "session.next.step.ended":
          case "session.next.step.failed":
            active.delete(event.data.assistantMessageID)
        }
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return Service.of({
      capture: () => {
        // Keep immutable values across the database read: a turn can settle while it is in flight.
        const before = new Map(active)
        return (messages) =>
          messages.map((message) => {
            if (message.type !== "assistant") return message
            const parts = active.get(message.id) ?? before.get(message.id)
            if (!parts) return message
            return {
              ...message,
              content: message.content.map((part) => {
                if (part.type !== "text" && part.type !== "reasoning") return part
                const text = parts.get(`${part.type}:${part.id}`)
                // A durable final value always wins over an older captured prefix.
                return text !== undefined && text.startsWith(part.text) ? { ...part, text } : part
              }),
            }
          })
      },
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node] })
