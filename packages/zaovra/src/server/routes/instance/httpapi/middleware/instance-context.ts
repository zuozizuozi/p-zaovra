import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { WorkspaceRouteContext } from "./workspace-routing"

const placementReads = new Set([
  "/config",
  "/event",
  "/lsp",
  "/formatter",
  "/path",
  "/file",
  "/file/content",
  "/find",
  "/find/file",
  "/vcs",
  "/vcs/status",
  "/vcs/diff",
  "/vcs/diff/raw",
])

export class InstanceContextMiddleware extends HttpApiMiddleware.Service<
  InstanceContextMiddleware,
  {
    requires: WorkspaceRouteContext
  }
>()("@zaovra/ExperimentalHttpApiInstanceContext") {}

function decode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function provideInstanceContext<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E>,
  store: InstanceStore.Interface,
  project: Project.Interface,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  WorkspaceRouteContext | HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const route = yield* WorkspaceRouteContext
    const request = yield* HttpServerRequest.HttpServerRequest
    const directory = FSUtil.resolve(decode(route.directory))
    const pathname = new URL(request.url, "http://localhost").pathname
    // Path discovery, config writes and filesystem/Git operations only need placement. Loading
    // the legacy runtime here rejects valid native configuration before dispatch.
    const ctx =
      (request.method === "PATCH" && pathname === "/config") ||
      (request.method === "POST" && (pathname === "/instance/dispose" || pathname === "/vcs/apply")) ||
      (request.method === "GET" && placementReads.has(pathname))
        ? yield* project.fromDirectory(directory).pipe(
            Effect.map((result) => ({
              directory,
              worktree: result.sandbox,
              project: result.project,
            })),
          )
        : yield* store.load({ directory })
    return yield* effect.pipe(
      Effect.provideService(InstanceRef, ctx),
      Effect.provideService(WorkspaceRef, route.workspaceID),
    )
  })
}

export const instanceContextLayer = Layer.effect(
  InstanceContextMiddleware,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const project = yield* Project.Service
    return InstanceContextMiddleware.of((effect) => provideInstanceContext(effect, store, project))
  }),
)
