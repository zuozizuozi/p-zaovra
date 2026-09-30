import { Location } from "@zaovra-ai/core/location"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { LocationServiceMap } from "@zaovra-ai/core/location-services"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { WorkspaceV2 } from "@zaovra-ai/core/workspace"
import { PluginV2 } from "@zaovra-ai/core/plugin"
import { PluginInternal } from "@zaovra-ai/core/plugin/internal"
import { Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@zaovra/HttpApiLocation",
) {}

export function response<A, E, R>(data: Effect.Effect<A, E, R>, readiness?: "agents" | "catalog") {
  return Effect.gen(function* () {
    if (readiness) {
      const plugins = yield* PluginV2.Service
      yield* plugins
        .wait(readiness === "agents" ? PluginInternal.agentReadyID : PluginInternal.readyID)
        .pipe(Effect.timeout("15 seconds"), Effect.orDie)
    }
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        workspaceID: location.workspaceID,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

function ref(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  const query = new URL(request.url, "http://localhost").searchParams
  const workspaceID = query.get("location[workspace]") || request.headers["x-zaovra-workspace"]
  const directory =
    query.get("location[directory]") ||
    (request.headers["x-zaovra-directory"] ? decode(request.headers["x-zaovra-directory"]) : process.cwd())
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
    workspaceID: workspaceID ? WorkspaceV2.ID.make(workspaceID) : undefined,
  })
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const fs = yield* FSUtil.Service
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const location = ref(request)
        // Check before constructing/caching the Location layer. A moved project
        // must not poison its service entry or prevent reopening after restore.
        const exists = yield* fs.stat(location.directory).pipe(
          Effect.as(true),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
          Effect.orDie,
        )
        if (!exists)
          return HttpServerResponse.jsonUnsafe(
            { name: "DirectoryUnavailableError", data: { directory: location.directory } },
            { status: 404 },
          )
        return yield* effect.pipe(Effect.provide(locations.get(location)))
      }),
    )
  }),
)
