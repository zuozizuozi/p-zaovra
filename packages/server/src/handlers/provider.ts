import { Catalog } from "@zaovra-ai/core/catalog"
import { Integration } from "@zaovra-ai/core/integration"
import { ProviderModels } from "@zaovra-ai/core/provider-models"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { ProviderNotFoundError, ServiceUnavailableError } from "@zaovra-ai/protocol/errors"
import { response } from "../location"

export const ProviderHandler = HttpApiBuilder.group(Api, "server.provider", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "provider.list",
        Effect.fn(function* () {
          const catalog = yield* Catalog.Service
          return yield* response(catalog.provider.available(), "catalog")
        }),
      )
      .handle(
        "provider.models",
        Effect.fn(function* (ctx) {
          const catalog = yield* Catalog.Service
          const integrations = yield* Integration.Service
          return yield* response(
            Effect.gen(function* () {
              const provider = yield* catalog.provider.get(ctx.params.providerID)
              if (!provider)
                return yield* new ProviderNotFoundError({
                  providerID: ctx.params.providerID,
                  message: "Provider not found",
                })
              const connection = yield* integrations.connection.active(
                provider.integrationID ?? Integration.ID.make(provider.id),
              )
              const credential = connection
                ? yield* integrations.connection
                    .resolve(connection)
                    .pipe(
                      Effect.mapError(
                        () =>
                          new ServiceUnavailableError({
                            service: "provider-models",
                            message: "Model discovery unavailable",
                          }),
                      ),
                    )
                : undefined
              return yield* Effect.tryPromise({
                try: (signal) => ProviderModels.discover(provider, credential, signal),
                // Upstream exceptions can include request headers or response bodies.
                catch: () =>
                  new ServiceUnavailableError({ service: "provider-models", message: "Model discovery unavailable" }),
              })
            }),
            "catalog",
          )
        }),
      )
      .handle(
        "provider.get",
        Effect.fn(function* (ctx) {
          const catalog = yield* Catalog.Service
          return yield* response(
            Effect.gen(function* () {
              const provider = yield* catalog.provider.get(ctx.params.providerID)
              if (!provider)
                return yield* new ProviderNotFoundError({
                  providerID: ctx.params.providerID,
                  message: `Provider not found: ${ctx.params.providerID}`,
                })
              return provider
            }),
            "catalog",
          )
        }),
      )
  }),
)
