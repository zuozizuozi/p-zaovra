import { Location } from "@zaovra-ai/core/location"
import { MemoryStore } from "@zaovra-ai/core/memory/store"
import { Memory } from "@zaovra-ai/schema/memory"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

const scope = (layer: "project" | "user" | undefined) =>
  layer === "user"
    ? Effect.succeed(Memory.Scope.user)
    : Location.Service.use((location) =>
        Effect.succeed(MemoryStore.scope({ project: location.project.id, directory: location.directory })),
      )

export const MemoryHandler = HttpApiBuilder.group(Api, "server.memory", (handlers) =>
  handlers
    .handle(
      "memory.list",
      Effect.fn(function* (ctx) {
        const store = yield* MemoryStore.Service
        return { data: yield* store.list(yield* scope(ctx.query.layer)) }
      }),
    )
    .handle(
      "memory.create",
      Effect.fn(function* (ctx) {
        const store = yield* MemoryStore.Service
        const note = yield* store.write({
          scope: yield* scope(ctx.payload.layer),
          kind: ctx.payload.kind,
          text: ctx.payload.text,
          origin: "user",
          status: "verified",
          verification: "written by the user",
        })
        return { data: note ?? null }
      }),
    )
    .handle(
      "memory.update",
      Effect.fn(function* (ctx) {
        const store = yield* MemoryStore.Service
        return { data: (yield* store.edit(ctx.params.id, ctx.payload)) ?? null }
      }),
    )
    .handle(
      "memory.remove",
      Effect.fn(function* (ctx) {
        const store = yield* MemoryStore.Service
        yield* store.remove(ctx.params.id)
        return HttpApiSchema.NoContent.make()
      }),
    )
    .handle(
      "memory.clear",
      Effect.fn(function* (ctx) {
        const store = yield* MemoryStore.Service
        yield* store.clear(yield* scope(ctx.query.layer))
        return HttpApiSchema.NoContent.make()
      }),
    ),
)
