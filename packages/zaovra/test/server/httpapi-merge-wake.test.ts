import { expect, test } from "bun:test"
import { WorkGroup } from "@zaovra-ai/protocol/groups/work"
import { Server } from "../../src/server/server"

test("retired WorkGraph HTTP operations stay Gone without dispatch", async () => {
  const app = Server.Default().app
  for (const endpoint of Object.values(WorkGroup.endpoints)) {
    const route = endpoint.path
      .replace(":goalID", "goal_retired")
      .replace(":taskID", "task_retired")
      .replace(":attemptID", "attempt_retired")
      .replace(":key", "retired")
    const response = await app.request(route, {
      method: endpoint.method,
      ...(endpoint.method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "{}" }),
    })
    expect({ operation: endpoint.name, status: response.status }).toEqual({ operation: endpoint.name, status: 410 })
    expect(await response.text()).toBe("")
  }
})
