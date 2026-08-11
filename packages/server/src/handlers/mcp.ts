import { MCP } from "@zaovra-ai/core/mcp"
import { InvalidRequestError } from "@zaovra-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

const mutate = <A>(effect: Effect.Effect<A, MCP.NotFoundError>) =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new InvalidRequestError({
          message: `MCP server is not configured: ${error.name}`,
          kind: "mcp_not_found",
        }),
    ),
  )

export const MCPHandler = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle("mcp.status", () =>
        Effect.gen(function* () {
          const service = yield* MCP.Service
          return yield* response(service.status())
        }),
      )
      .handle("mcp.resources", () =>
        Effect.gen(function* () {
          const service = yield* MCP.Service
          return yield* response(service.resources())
        }),
      )
      .handle("mcp.connect", (ctx) =>
        Effect.gen(function* () {
          const service = yield* MCP.Service
          yield* mutate(service.reconnect(ctx.params.name))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle("mcp.disconnect", (ctx) =>
        Effect.gen(function* () {
          const service = yield* MCP.Service
          yield* mutate(service.disconnect(ctx.params.name))
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
