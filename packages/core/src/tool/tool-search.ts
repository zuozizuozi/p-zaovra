export * as ToolSearch from "./tool-search"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
export const name = "tool_search"
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const registry = yield* ToolRegistry.Service
    const agents = yield* AgentV2.Service
    const permissions = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Discover additional tools before using them (browser, task/delegation, web, publishing and other registered capabilities). Supply exact names or query words. Queries return up to ten matches ranked by matching words. Empty or unmatched queries list the available catalog without activating tools. Successful matches are offered with their full input schemas on the next turn and remain available on continuation. This only discovers tools; it does not execute them or grant permissions.",
          observation: true,
          input: Schema.Struct({
            names: Schema.optional(Schema.Array(Schema.String)),
            query: Schema.optional(Schema.String),
          }),
          output: Schema.Struct({
            activated: Schema.Array(Schema.String),
            available: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
          }),
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permissions
                .assert({
                  action: name,
                  resources: ["*"],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError((error) => new Tool.Failure({ message: error.message })))
              const agent = yield* agents.get(context.agent)
              const catalog = (yield* registry.materialize(agent?.permissions)).definitions.filter(
                (tool) => tool.name !== name,
              )
              if (input.names?.some((requested) => !catalog.some((tool) => tool.name === requested)))
                return yield* new Tool.Failure({
                  message: "Unknown or unavailable tool requested. List the catalog or use a different query.",
                })
              const terms = [...new Set(input.query?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
              const matches = input.names?.length
                ? catalog.filter((tool) => input.names!.includes(tool.name))
                : terms.length
                  ? catalog
                      .map((tool) => {
                        const words = new Set(
                          (tool.name + " " + tool.description).toLowerCase().match(/[\p{L}\p{N}]+/gu),
                        )
                        return { tool, score: terms.filter((term) => words.has(term)).length }
                      })
                      .filter((match) => match.score > 0)
                      .sort((a, b) => b.score - a.score)
                      .slice(0, 10)
                      .map((match) => match.tool)
                  : []
              return {
                activated: matches.map((tool) => tool.name),
                available: (matches.length ? matches : catalog).map((tool) => ({
                  name: tool.name,
                  description: tool.description.split("\n")[0]!.slice(0, 200),
                })),
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)
export const node = makeLocationNode({
  name: "tool/search",
  layer,
  deps: [ToolRegistry.node, ToolRegistry.toolsNode, AgentV2.node, PermissionV2.node],
})
