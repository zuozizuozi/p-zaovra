import { CustomizationGroup } from "@zaovra-ai/protocol/groups/customization"
import { CommandGroup } from "@zaovra-ai/protocol/groups/command"
import { MCPGroup } from "@zaovra-ai/protocol/groups/mcp"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { Global } from "@zaovra-ai/core/global"
import { LocationServiceMap } from "@zaovra-ai/core/location-service-map"
import { SessionExecution } from "@zaovra-ai/core/session/execution"
import { SessionExecutionLocal } from "@zaovra-ai/core/session/execution/local"
import { CustomizationHandler } from "../handlers/customization"
import { CommandHandler } from "../handlers/command"
import { MCPHandler } from "../handlers/mcp"
import { LocationMiddleware, layer } from "../location"
import { authorizationLayer } from "../middleware/authorization"
import { schemaErrorLayer } from "../middleware/schema-error"
import { ServerAuth } from "../auth"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import fs from "node:fs/promises"
import path from "node:path"
import { Layer, Option } from "effect"

const root = process.env.ZAOVRA_766_TEST_ROOT
if (!root || !path.isAbsolute(root)) throw new Error("An absolute isolated test root is required")
await fs.mkdir(root, { recursive: true })
const services = AppNodeBuilder.build(LayerNode.group([FSUtil.node, Global.node, LocationServiceMap.node]), [
  [SessionExecution.node, SessionExecutionLocal.node],
])
const api = HttpApi.make("server")
  .add(CustomizationGroup.middleware(LocationMiddleware))
  .add(CommandGroup.middleware(LocationMiddleware))
  .add(MCPGroup.middleware(LocationMiddleware))
const web = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(api).pipe(
    Layer.provide([CustomizationHandler, CommandHandler, MCPHandler]),
    Layer.provide(layer),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    Layer.provide(ServerAuth.Config.configLayer({ username: "zaovra", password: Option.none() })),
    HttpRouter.provideRequest(services),
    Layer.provide(services),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
)
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (new URL(request.url).pathname === "/__766/stop" && request.method === "POST") {
      setTimeout(async () => {
        await web.dispose()
        await server.stop(true)
        await Bun.write(path.join(root, "stopped.json"), JSON.stringify({ stopped: true }))
      }, 50)
      return new Response("stopping")
    }
    return web.handler(request)
  },
})
await Bun.write(path.join(root, "listening.json"), JSON.stringify({ url: server.url.toString(), pid: process.pid }))
