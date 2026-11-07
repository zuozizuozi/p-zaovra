import { expect, test } from "bun:test"
import { Layer, Option } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { WorkGroup } from "@zaovra-ai/protocol/groups/work"
import { WorkDisabledHandler } from "./work-disabled"
import { authorizationLayer } from "../middleware/authorization"
import { schemaErrorLayer } from "../middleware/schema-error"
import { ServerAuth } from "../auth"

test("all retired WorkGraph HTTP operations return Gone without runtime services", async () => {
  const api = HttpApi.make("server").add(WorkGroup)
  const web = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(WorkDisabledHandler),
      Layer.provide(authorizationLayer),
      Layer.provide(schemaErrorLayer),
      Layer.provide(ServerAuth.Config.configLayer({ username: "zaovra", password: Option.none() })),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  )
  try {
    for (const endpoint of Object.values(WorkGroup.endpoints)) {
      const path = endpoint.path
        .replace(":goalID", "goal_retired")
        .replace(":taskID", "task_retired")
        .replace(":attemptID", "attempt_retired")
        .replace(":key", "retired")
      const response = await web.handler(
        new Request("http://localhost" + path, {
          method: endpoint.method,
          ...(endpoint.method === "GET"
            ? {}
            : {
                body: JSON.stringify({
                  token: "retired",
                  approved: false,
                  minimumAgeMs: 60000,
                  dryRun: true,
                  location: { directory: "F:/retired" },
                  objective: "retired",
                  acceptanceCriteria: [],
                  tasks: [],
                  taskID: "task_retired",
                  resolution: "retry",
                  key: "retired",
                  handoffID: "handoff_retired",
                  itemDigest: "0".repeat(64),
                  kind: "decision",
                  text: "retired",
                }),
                headers: { "content-type": "application/json" },
              }),
        }),
      )
      expect({ operation: endpoint.name, status: response.status }).toEqual({ operation: endpoint.name, status: 410 })
    }
  } finally {
    await web.dispose()
  }
})
