import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

// Keep the historical wire schema available, but never load or start the retired runtime.
export const WorkDisabledHandler = HttpApiBuilder.group(Api, "server.work", (handlers) =>
  handlers
    .handleRaw("work.mergeReview", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.mergeDecide", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.list", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.create", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.active", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.artifacts", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.artifactCollect", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.get", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.expand", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.replan", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.resume", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.pause", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.cancel", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.resolveUnknown", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.resolveMemory", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.updateMemory", () => Effect.succeed(HttpServerResponse.empty({ status: 410 })))
    .handleRaw("work.deleteMemory", () => Effect.succeed(HttpServerResponse.empty({ status: 410 }))),
)
