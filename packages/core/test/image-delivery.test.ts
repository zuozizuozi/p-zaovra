import { expect } from "bun:test"
import path from "node:path"
import { Effect, Layer, DateTime, Schema, Stream } from "effect"
import { ConfigV1 } from "../src/v1/config/config"
import { LLM, LLMClient } from "@zaovra-ai/llm"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Catalog } from "../src/catalog"
import { Config } from "../src/config"
import { ConfigMigrateV1 } from "../src/v1/config/migrate"
import { ConfigProviderPlugin } from "../src/config/plugin/provider"
import { Global } from "../src/global"
import { Integration } from "../src/integration"
import { Location } from "../src/location"
import { ReadTool } from "../src/tool/read"
import { ReadToolFileSystem } from "../src/tool/read-filesystem"
import { ToolRegistry } from "../src/tool/registry"
import { SessionExecution } from "../src/session/execution"
import { SessionV2 } from "../src/session"
import { SessionMessage } from "../src/session/message"
import { SessionEvent } from "../src/session/event"
import { SessionInput } from "../src/session/input"
import { EventV2 } from "../src/event"
import { Database } from "../src/database/database"
import { SessionRunnerModel } from "../src/session/runner/model"
import { toLLMMessages } from "../src/session/runner/to-llm-message"
import { AbsolutePath } from "../src/schema"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { AgentV2 } from "../src/agent"
import { catalogHost, integrationHost, host } from "./plugin/host"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { settleTool } from "./lib/tool"
import { dynamicResponse } from "../../llm/test/lib/http"
import { sseEvents } from "../../llm/test/lib/sse"
import harness from "./fixture/harness-image-config.json"

for (const scenario of ["harness-omitted", "supported", "unsupported", "oversize", "alias", "builtin"] as const)
  it.live(
    `469 real read/history/provider image delivery: ${scenario}`,
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const config = structuredClone(harness)
            const explicit = scenario !== "harness-omitted" && scenario !== "builtin"
            const configured = {
              ...config.provider.gravitex.models["gpt-6-luna"],
              ...(explicit
                ? { modalities: { input: scenario === "unsupported" ? ["text"] : ["text", "image"], output: ["text"] } }
                : {}),
            }
            const providerID = ProviderV2.ID.make(scenario === "builtin" ? "openai" : "gravitex")
            const modelID = ModelV2.ID.make(scenario === "alias" ? "image-alias" : "gpt-6-luna")
            config.model = `${providerID}/${modelID}`
            const document = new Config.Document({
              type: "document",
              info: Schema.decodeUnknownSync(Config.Info)(
                ConfigMigrateV1.migrate(
                  Schema.decodeUnknownSync(ConfigV1.Info)({
                    ...config,
                    provider: { [providerID]: { ...config.provider.gravitex, models: { [modelID]: configured } } },
                  }),
                ),
              ),
            })
            const program = Effect.gen(function* () {
              const catalog = yield* Catalog.Service
              const integration = yield* Integration.Service
              yield* ConfigProviderPlugin.Plugin.effect(
                host({ catalog: catalogHost(catalog), integration: integrationHost(integration) }),
              )
              const model = yield* catalog.model.get(providerID, modelID)
              expect(model).toBeDefined()
              const agents = yield* AgentV2.Service
              yield* agents.transform((draft) =>
                draft.update(AgentV2.ID.make("build"), (agent) => {
                  agent.permissions = [{ action: "read", resource: "*", effect: "allow" }]
                }),
              )
              const sessions = yield* SessionV2.Service
              const session = yield* sessions.create({
                location: { directory: AbsolutePath.make(tmp.path) },
                model: { providerID, id: modelID },
              })
              const resolved = yield* SessionRunnerModel.resolve(session, model!)
              const png = Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                "base64",
              )
              const image = path.join(tmp.path, "pixel.png")
              yield* Effect.promise(() =>
                Bun.write(
                  image,
                  scenario === "oversize"
                    ? Buffer.concat([png, Buffer.alloc(ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES)])
                    : png,
                ),
              )
              const events = yield* EventV2.Service
              const database = yield* Database.Service
              const admitted = yield* sessions.prompt({
                sessionID: session.id,
                prompt: { text: "Read pixel.png" },
                resume: false,
              })
              yield* SessionInput.promoteSteers(database.db, events, session.id, admitted.admittedSeq)
              const messageID = SessionMessage.ID.create()
              const timestamp = yield* DateTime.now
              const context = {
                sessionID: session.id,
                assistantMessageID: messageID,
                agent: AgentV2.ID.make("build"),
                inputModalities: resolved.inputModalities,
              }
              yield* events.publish(SessionEvent.Step.Started, {
                sessionID: session.id,
                assistantMessageID: messageID,
                timestamp,
                agent: "build",
                model: { id: modelID, providerID },
              })
              yield* events.publish(SessionEvent.Tool.Input.Started, {
                ...context,
                timestamp,
                callID: "read-image",
                name: "read",
              })
              yield* events.publish(SessionEvent.Tool.Called, {
                ...context,
                timestamp,
                callID: "read-image",
                tool: "read",
                input: { path: image },
                provider: { executed: false },
              })
              const registry = yield* ToolRegistry.Service
              const result = yield* settleTool(registry, {
                ...context,
                call: { type: "tool-call", id: "read-image", name: "read", input: { path: image } },
              })
              if (result.result.type === "error") return yield* Effect.die(JSON.stringify(result))
              expect(result.result.type).not.toBe("error")
              yield* events.publish(SessionEvent.Tool.Success, {
                ...context,
                timestamp,
                callID: "read-image",
                structured: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
                  result.output?.structured ?? {},
                ),
                content: result.output?.content ?? [],
                provider: { executed: false },
              })
              const history = yield* sessions.context(session.id)
              const bodies: string[] = []
              yield* LLMClient.stream(
                LLM.request({
                  id: "image-wire",
                  model: resolved,
                  messages: toLLMMessages(history, resolved),
                  system: "Fixed local fixture",
                }),
              ).pipe(
                Stream.runCollect,
                Effect.provide(
                  dynamicResponse((request) => {
                    bodies.push(request.text)
                    return Effect.succeed(
                      request.respond(
                        sseEvents({
                          type: "response.completed",
                          response: {
                            id: "fixed-image",
                            status: "completed",
                            output: [],
                            usage: { input_tokens: 1, output_tokens: 0 },
                          },
                        }),
                        { headers: { "content-type": "text/event-stream" } },
                      ),
                    )
                  }),
                ),
              )
              if (process.env.ZAOVRA_IMAGE_EVIDENCE)
                yield* Effect.promise(() =>
                  Bun.write(
                    path.join(process.env.ZAOVRA_IMAGE_EVIDENCE!, `${scenario}.json`),
                    JSON.stringify(
                      {
                        capabilities: model!.capabilities,
                        apiID: resolved.id,
                        history,
                        wire: bodies.map((body) => JSON.parse(body)),
                      },
                      null,
                      2,
                    ),
                  ),
                )
              expect(bodies).toHaveLength(1)
              const sent = scenario === "supported" || scenario === "alias" || scenario === "builtin"
              expect(bodies[0].includes("data:image/png;base64,")).toBe(sent)
              expect(bodies[0]).toContain('"model":"gpt-6-luna"')
              if (!sent) expect(bodies[0]).toContain("NOT sent")
              if (scenario === "oversize") expect(bodies[0]).toContain("media ingestion limit")
              expect(JSON.stringify(yield* sessions.context(session.id))).toContain(
                sent ? "data:image/png;base64," : "NOT sent",
              )
            })
            return yield* program.pipe(
              Effect.provide(
                AppNodeBuilder.build(
                  LayerNode.group([
                    SessionV2.node,
                    ReadTool.node,
                    AgentV2.node,
                    Catalog.node,
                    ToolRegistry.node,
                    EventV2.node,
                    Database.node,
                    Config.node,
                    Integration.node,
                  ]),
                  [
                    [
                      Location.node,
                      Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(tmp.path) })),
                    ],
                    [Global.node, Global.layerWith({ data: tmp.path })],
                    [SessionExecution.node, SessionExecution.noopLayer],
                    [
                      Config.node,
                      Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([document]) })),
                    ],
                  ],
                ),
              ),
            )
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    30000,
  )
