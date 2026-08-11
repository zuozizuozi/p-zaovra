import { Database } from "@zaovra-ai/core/database/database"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { httpClient } from "@zaovra-ai/core/effect/app-node-platform"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { EventV2 } from "@zaovra-ai/core/event"
import { Credential } from "@zaovra-ai/core/credential"
import { PermissionSaved } from "@zaovra-ai/core/permission/saved"
import { PtyTicket } from "@zaovra-ai/core/pty/ticket"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { LocationServiceMap } from "@zaovra-ai/core/location-service-map"
import { SessionExecutionLocal } from "@zaovra-ai/core/session/execution/local"
import { Work } from "@zaovra-ai/core/work"
import { WorkArtifact } from "@zaovra-ai/core/work/artifact"
import { WorkController } from "@zaovra-ai/core/work/controller"
import { WorkExecution } from "@zaovra-ai/core/work/execution"
import { WorkExecutionLocal } from "@zaovra-ai/core/work/execution-local"
import { WorkRecovery } from "@zaovra-ai/core/work/recovery"
import { WorkStore } from "@zaovra-ai/core/work/store"
import { WorkPlacement } from "@zaovra-ai/core/work/placement"
import { WorkWorker } from "@zaovra-ai/core/work/worker"
import { WorkRemoteJob } from "@zaovra-ai/core/work/remote-job"
import { ToolOutputStore } from "@zaovra-ai/core/tool-output-store"
import { TaskTool } from "@zaovra-ai/core/tool/task"
import { TaskRecovery } from "@zaovra-ai/core/tool/task-recovery"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { layer as locationLayer } from "./location"
import { sessionLocationLayer } from "./middleware/session-location"

const applicationServices = LayerNode.group([
  Database.node,
  EventV2.node,
  httpClient,
  ToolOutputStore.cleanupNode,
  SessionV2.node,
  TaskTool.node,
  TaskRecovery.startupNode,
  Work.node,
  WorkArtifact.node,
  WorkController.node,
  WorkStore.node,
  WorkWorker.node,
  WorkRemoteJob.node,
  WorkPlacement.node,
  WorkRecovery.startupNode,
  PermissionSaved.node,
  PtyTicket.node,
  Credential.node,
  PtyEnvironment.node,
  LocationServiceMap.node,
])

export function createRoutes(password?: string) {
  return makeRoutes(
    password
      ? ServerAuth.Config.configLayer({ username: "zaovra", password: Option.some(password) })
      : ServerAuth.Config.layer,
  )
}

export function createEmbeddedRoutes() {
  return makeRoutes(ServerAuth.Config.configLayer({ username: "zaovra", password: Option.none() }))
}

function makeRoutes<AuthError, AuthServices>(auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>) {
  const serviceLayer = AppNodeBuilder.build(applicationServices, [
    [SessionExecution.node, SessionExecutionLocal.node],
    [WorkExecution.node, WorkExecutionLocal.node],
  ])

  return HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(handlers),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(authorizationLayer),
    Layer.provide(schemaErrorLayer),
    Layer.provide(auth),
    Layer.provide(serviceLayer),
  )
}

export const routes = createRoutes()

export const webHandler = () =>
  HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), { disableLogger: true })
