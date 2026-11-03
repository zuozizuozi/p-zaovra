import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer, Schema, Scope } from "effect"
import { AgentV2 } from "../src/agent"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { PermissionV2 } from "../src/permission"
import { PluginV2 } from "../src/plugin"
import { PluginInternal } from "../src/plugin/internal"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { ToolProfile } from "../src/session/tool-profile"
import { BuiltInTools } from "../src/tool/builtins"
import { Tool } from "../src/tool/tool"
import { ToolRegistry } from "../src/tool/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { settleTool, toolIdentity } from "./lib/tool"
import queries from "./fixtures/tool-search-queries539.json"

for (const [index, row] of queries.entries())
  test(
    `539 R1 original query ${index + 1}: ${row.task}`,
    () =>
      withSearch([], (sessionID) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const result = yield* search(registry, sessionID, row.input)
          expect(result.result.type).not.toBe("error")
          const output = result.output?.structured as SearchOutput
          if (process.env.ZAOVRA_TOOL_SEARCH_REPORT) {
            const catalog = yield* registry.materialize()
            yield* Effect.promise(async () => {
              await Bun.write(
                path.join(process.env.ZAOVRA_TOOL_SEARCH_REPORT!, row.callID + ".json"),
                JSON.stringify({
                  task: row.task,
                  input: row.input,
                  output,
                  catalog: catalog.definitions.map((tool) => ({ name: tool.name, description: tool.description })),
                }),
              )
            })
          }
          expect(output.available.length).toBeGreaterThan(0)
          if (row.webIntent)
            expect(output.available.some((tool) => tool.name === "websearch" || tool.name === "webfetch")).toBe(true)
          if (output.activated.length) {
            expect(output.activated.length).toBeLessThanOrEqual(10)
            expect(output.available.map((tool) => tool.name)).toEqual(expect.arrayContaining(output.activated))
          }
          const definitions = (yield* registry.materialize()).definitions
          expect(definitions.map((tool) => tool.name)).toEqual(expect.arrayContaining(["webfetch", "websearch"]))
          const advertised = ToolProfile.select(definitions, { model: "gpt-6-luna", history: [] })
          expect(advertised.map((tool) => tool.name)).toEqual(expect.arrayContaining(["webfetch", "websearch"]))
        }),
      ),
    10000,
  )

for (const input of [{}, { query: "" }, { query: "   " }, { query: "!!!，。" }, { query: "qzxunknownlexeme" }])
  test(`539 empty/unmatched input lists the allowed catalog without activation: ${JSON.stringify(input)}`, () =>
    withSearch([], (sessionID) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const catalog = (yield* registry.materialize()).definitions.filter((tool) => tool.name !== "tool_search")
        const output = (yield* search(registry, sessionID, input)).output?.structured as SearchOutput
        expect(output.activated).toEqual([])
        expect(output.available).toEqual(
          catalog.map((tool) => ({ name: tool.name, description: tool.description.split("\n")[0]!.slice(0, 200) })),
        )
      }),
    ))

test("539 query terms respect word boundaries and names retain exact selection", () =>
  withSearch([], (sessionID) =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(
        (yield* search(registry, sessionID, { query: "browserless taskbar unwriteable" })).output?.structured,
      ).toMatchObject({
        activated: [],
      })
      const exact = (yield* search(registry, sessionID, { names: ["webfetch", "websearch"], query: "bash" })).output
        ?.structured as SearchOutput
      expect(exact.activated).toEqual(["webfetch", "websearch"])
      expect(exact.available.map((tool) => tool.name)).toEqual(exact.activated)
      expect((yield* search(registry, sessionID, { names: ["WEBSEARCH"] })).result.type).toBe("error")
      expect((yield* search(registry, sessionID, { query: "WEB,search\nHTTP" })).output?.structured).toMatchObject({
        activated: expect.arrayContaining(["websearch"]),
      })
    }),
  ))

test("539 unique matching terms rank before one-word matches and bound query activation to ten", () =>
  withSearch([], (sessionID) =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const executed: string[] = []
      const suffixes = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"]
      for (const suffix of suffixes)
        yield* registry.register({
          ["rank_" + suffix]: Tool.make({
            description: suffix === "m" ? "xenonzebra gammakilo" : "xenonzebra",
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () => Effect.sync(() => executed.push(suffix)).pipe(Effect.as("must not execute")),
          }),
        })
      const output = (yield* search(registry, sessionID, { query: "XENONZEBRA,xenonzebra gammakilo" })).output
        ?.structured as SearchOutput
      expect(output.activated).toEqual(["rank_m"])
      expect(output.available.map((tool) => tool.name)).toEqual([
        "rank_m",
        "rank_a",
        "rank_b",
        "rank_c",
        "rank_d",
        "rank_e",
        "rank_f",
        "rank_g",
        "rank_h",
        "rank_i",
      ])
      expect(executed).toEqual([])
      const exact = (yield* search(registry, sessionID, {
        names: suffixes.map((suffix) => "rank_" + suffix),
      })).output?.structured as SearchOutput
      expect(exact.activated).toHaveLength(13)
      expect(executed).toEqual([])
    }),
  ))

for (const input of [{ query: "web search HTTP fetch" }, { query: "qzxunknownlexeme" }, {}])
  test(`539 whole-tool deny remains invisible in matches/fallback/default advertisements: ${JSON.stringify(input)}`, () =>
    withSearch(
      [
        { action: "websearch", resource: "*", effect: "deny" },
        { action: "webfetch", resource: "*", effect: "deny" },
      ],
      (sessionID) =>
        Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const agents = yield* AgentV2.Service
          const agent = yield* agents.get(toolIdentity.agent)
          const materialized = yield* registry.materialize(agent?.permissions)
          for (const name of ["websearch", "webfetch"])
            expect(
              ToolProfile.select(materialized.definitions, { model: "gpt-6-luna", history: [] }).map(
                (tool) => tool.name,
              ),
            ).not.toContain(name)
          const output = (yield* search(registry, sessionID, input)).output?.structured as SearchOutput
          for (const name of ["websearch", "webfetch"]) {
            expect(output.available.map((tool) => tool.name)).not.toContain(name)
            expect(output.activated).not.toContain(name)
            expect((yield* search(registry, sessionID, { names: [name] })).result.type).toBe("error")
          }
        }),
    ))

type SearchOutput = { activated: string[]; available: { name: string; description: string }[] }

for (const query of ["how to do this", "the for a to and of in with file files", "的，了 和 在 是 与 或 请 帮 我 使用"])
  test(`541 stopword-only query cannot activate tools: ${query}`, () =>
    withSearch([], (sessionID) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const executed: string[] = []
        yield* registry.register({
          stopword_decoy: Tool.make({
            description: "how to do this the for a and of in with file files 的 了 和 在 是 与 或 请 帮 我 使用",
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () => Effect.sync(() => executed.push("decoy")).pipe(Effect.as("not executed")),
          }),
        })
        const output = (yield* search(registry, sessionID, { query })).output?.structured as SearchOutput
        expect(output.activated).toEqual([])
        expect(output.available.map((tool) => tool.name)).toContain("stopword_decoy")
        expect(executed).toEqual([])
      }),
    ))

test("541 search for the file activates search capabilities rather than generic file operators", () =>
  withSearch([], (sessionID) =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const output = (yield* search(registry, sessionID, { query: "search for the file" })).output
        ?.structured as SearchOutput
      expect(output.activated).toContain("grep")
      expect(output.activated.length).toBeLessThanOrEqual(5)
      for (const name of output.activated)
        expect(["evidence_read", "evidence_search", "glob", "grep", "websearch"]).toContain(name)
      for (const name of ["bash", "read", "write", "edit", "task", "question", "skill"])
        expect(output.activated).not.toContain(name)
    }),
  ))

test("541 exact names bypass lexical stopwords without executing the selected tool", () =>
  withSearch([], (sessionID) =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        the: Tool.make({
          description: "A deliberately named application tool",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.die("Discovery must not execute this tool"),
        }),
      })
      const output = (yield* search(registry, sessionID, { names: ["the"], query: "how to do this" })).output
        ?.structured as SearchOutput
      expect(output.activated).toEqual(["the"])
      expect(output.available.map((tool) => tool.name)).toEqual(["the"])
    }),
  ))

test("541 activates all highest-score ties and leaves lower matches available without activation", () =>
  withSearch([], (sessionID) =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      for (const name of ["priority_alpha", "priority_beta", "priority_lower"])
        yield* registry.register({
          [name]: Tool.make({
            description: name === "priority_lower" ? "quasarprobe" : "quasarprobe orbitprobe",
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () => Effect.die("Discovery must not execute ranked tools"),
          }),
        })
      const output = (yield* search(registry, sessionID, { query: "quasarprobe orbitprobe" })).output
        ?.structured as SearchOutput
      expect(output.activated).toEqual(["priority_alpha", "priority_beta"])
      expect(output.available.map((tool) => tool.name)).toEqual(["priority_alpha", "priority_beta", "priority_lower"])
    }),
  ))

function search(registry: ToolRegistry.Interface, sessionID: SessionV2.ID, input: Record<string, unknown>) {
  return settleTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id: "discovery-539", name: "tool_search", input },
  })
}

async function withSearch(
  rules: PermissionV2.Ruleset,
  body: (sessionID: SessionV2.ID) => Effect.Effect<void, unknown, ToolRegistry.Service | AgentV2.Service | Scope.Scope>,
) {
  await using tmp = await tmpdir()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const plugins = yield* PluginV2.Service
        yield* plugins.wait(PluginInternal.agentReadyID)
        const agents = yield* AgentV2.Service
        yield* agents.transform((editor) =>
          editor.update(toolIdentity.agent, (agent) => {
            agent.permissions = [{ action: "tool_search", resource: "*", effect: "allow" }, ...rules]
          }),
        )
        const sessions = yield* SessionV2.Service
        const session = yield* sessions.create({ location: { directory: AbsolutePath.make(tmp.path) } })
        yield* body(session.id)
      }),
    ).pipe(
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            SessionV2.node,
            Database.node,
            AgentV2.node,
            PermissionV2.node,
            PluginV2.node,
            PluginInternal.node,
            BuiltInTools.node,
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
          ],
        ),
      ),
    ),
  )
}
