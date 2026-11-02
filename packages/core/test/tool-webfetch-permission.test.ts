import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Fiber, Layer, Scope } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AgentV2 } from "../src/agent"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { PermissionV2 } from "../src/permission"
import { PermissionSaved } from "../src/permission/saved"
import { PluginV2 } from "../src/plugin"
import { PluginInternal } from "../src/plugin/internal"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { ToolRegistry } from "../src/tool/registry"
import { WebFetchTool } from "../src/tool/webfetch"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { settleTool, toolIdentity } from "./lib/tool"

const canonical = "https://1.1.1.1/secret"
const variants = [
  canonical,
  "https://1.1.1.1:443/secret",
  "https://1.1.1.1/public/../secret",
  "https://1.1.1.1:443/public/../secret",
]

for (const url of variants) {
  test(
    `149 canonical URL deny precedes transport: ${url}`,
    () =>
      withWebFetch(
        [
          { action: "webfetch", resource: "*", effect: "allow" },
          { action: "webfetch", resource: canonical, effect: "deny" },
        ],
        (sessionID, requests) =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const result = yield* settleTool(registry, call(sessionID, url))
            expect(result.result.type).toBe("error")
            expect(requests).toEqual([])
            const permissions = yield* PermissionV2.Service
            expect(yield* permissions.list()).toEqual([])
          }),
      ),
    10000,
  )

  test(
    `149 allowed URL sends the canonical identity once: ${url}`,
    () =>
      withWebFetch([{ action: "webfetch", resource: "*", effect: "allow" }], (sessionID, requests) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const result = yield* settleTool(registry, call(sessionID, url))
          expect(result.result.type).not.toBe("error")
          expect(requests).toEqual([canonical])
          expect(result).toMatchObject({ output: { structured: { url: canonical, output: "local transport" } } })
        }),
      ),
    10000,
  )
}

for (const reply of ["once", "always"] as const) {
  test(
    `149 canonical ask shows raw metadata and authorizes the actual target: ${reply}`,
    () =>
      withWebFetch([{ action: "webfetch", resource: "*", effect: "ask" }], (sessionID, requests) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const permissions = yield* PermissionV2.Service
          const raw = variants[1]!
          const fiber = yield* settleTool(registry, call(sessionID, raw)).pipe(Effect.forkChild)
          const pending = yield* pendingRequest(permissions, sessionID)
          expect(pending.resources).toEqual([canonical])
          expect(pending.metadata).toMatchObject({ url: raw, format: "text" })
          expect(pending.source).toEqual({
            type: "tool",
            messageID: toolIdentity.assistantMessageID,
            callID: "canonical-webfetch",
          })
          expect(requests).toEqual([])
          yield* permissions.reply({ requestID: pending.id, reply })
          expect((yield* Fiber.join(fiber)).result.type).not.toBe("error")
          expect(requests).toEqual([canonical])
          expect(yield* permissions.list()).toEqual([])
        }),
      ),
    10000,
  )

  test(
    `149 fresh canonical deny vetoes ${reply} before sending`,
    () =>
      withWebFetch([{ action: "webfetch", resource: "*", effect: "ask" }], (sessionID, requests) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const permissions = yield* PermissionV2.Service
          const agents = yield* AgentV2.Service
          const fiber = yield* settleTool(registry, call(sessionID, variants[2]!)).pipe(Effect.forkChild)
          const pending = yield* pendingRequest(permissions, sessionID)
          yield* agents.transform((editor) =>
            editor.update(toolIdentity.agent, (agent) => {
              agent.permissions.push({ action: "webfetch", resource: canonical, effect: "deny" })
            }),
          )
          yield* permissions.reply({ requestID: pending.id, reply })
          expect((yield* Fiber.join(fiber)).result.type).toBe("error")
          expect(requests).toEqual([])
          const saved = yield* PermissionSaved.Service
          expect(yield* saved.list()).toEqual([])
          expect(yield* permissions.list()).toEqual([])
        }),
      ),
    10000,
  )
}

for (const action of ["*", "webfetch"])
  test(
    `149 whole-tool deny is preserved: ${action}`,
    () =>
      withWebFetch(
        [
          { action: "*", resource: "*", effect: "allow" },
          { action, resource: "*", effect: "deny" },
        ],
        (sessionID, requests) =>
          Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            expect((yield* settleTool(registry, call(sessionID, variants[3]!))).result.type).toBe("error")
            expect(requests).toEqual([])
          }),
      ),
    10000,
  )

test(
  "149 malformed URL never reaches permission or transport",
  () =>
    withWebFetch([{ action: "webfetch", resource: "*", effect: "ask" }], (sessionID, requests) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        expect((yield* settleTool(registry, call(sessionID, "not a URL"))).result.type).toBe("error")
        expect(requests).toEqual([])
        const permissions = yield* PermissionV2.Service
        expect(yield* permissions.list()).toEqual([])
      }),
    ),
  10000,
)

function call(sessionID: SessionV2.ID, url: string) {
  return {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call" as const, id: "canonical-webfetch", name: "webfetch", input: { url, format: "text" } },
  }
}

function pendingRequest(permissions: PermissionV2.Interface, sessionID: SessionV2.ID) {
  return Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const requests = yield* permissions.forSession(sessionID)
      if (requests[0]) return requests[0]
      yield* Effect.sleep(10)
    }
    return yield* Effect.die("Expected a real webfetch permission request")
  })
}

async function withWebFetch(
  rules: PermissionV2.Ruleset,
  body: (
    sessionID: SessionV2.ID,
    requests: string[],
  ) => Effect.Effect<
    void,
    unknown,
    AgentV2.Service | PermissionV2.Service | PermissionSaved.Service | ToolRegistry.Service | Scope.Scope
  >,
) {
  await using tmp = await tmpdir()
  const requests: string[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const plugins = yield* PluginV2.Service
        yield* plugins.wait(PluginInternal.agentReadyID)
        const agents = yield* AgentV2.Service
        yield* agents.transform((editor) =>
          editor.update(toolIdentity.agent, (agent) => {
            agent.permissions = [...rules]
          }),
        )
        const sessions = yield* SessionV2.Service
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
        yield* body(session.id, requests)
      }),
    ).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            SessionV2.node,
            Database.node,
            AgentV2.node,
            PermissionV2.node,
            PermissionSaved.node,
            PluginV2.node,
            PluginInternal.node,
            WebFetchTool.node,
            ToolRegistry.node,
            ToolRegistry.toolsNode,
          ]),
          [
            [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) }))],
            [
              Global.node,
              Global.layerWith({
                data: path.join(tmp.path, "data"),
                config: path.join(tmp.path, "config"),
                state: path.join(tmp.path, "state"),
              }),
            ],
            [SessionExecution.node, SessionExecution.noopLayer],
            [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
            [
              LayerNodePlatform.httpClient,
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.sync(() => {
                    requests.push(request.url)
                    return HttpClientResponse.fromWeb(
                      request,
                      new Response("local transport", { headers: { "content-type": "text/plain" } }),
                    )
                  }),
                ),
              ),
            ],
          ],
        ),
      ),
    ),
  )
}
