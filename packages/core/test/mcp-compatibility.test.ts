import path from "path"
import { expect } from "bun:test"
import { Config } from "@zaovra-ai/core/config"
import { ConfigMCP } from "@zaovra-ai/core/config/mcp"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { MCP } from "@zaovra-ai/core/mcp"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { ApplicationTools } from "@zaovra-ai/core/tool/application-tools"
import { ToolOutputStore } from "@zaovra-ai/core/tool-output-store"
import { Location } from "@zaovra-ai/core/location"
import { ProjectV2 } from "@zaovra-ai/core/project"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

import schemas from "./fixture/mcp-server-schemas.json"

const directory = AbsolutePath.make(path.resolve(import.meta.dirname, "fixture"))
const valid: Record<string, Record<string, unknown>> = {
  read_text_file: { path: "/tmp/example", head: 2 },
  write_file: { path: "/tmp/example", content: "hello" },
  search_files: { path: "/tmp", pattern: "*.txt", excludePatterns: ["node_modules"] },
  get_issue: { owner: "example", repo: "example", issue_number: 1 },
  create_issue: { owner: "example", repo: "example", title: "example", labels: ["test"] },
  search_repositories: { query: "mcp", page: 1 },
  browser_navigate: { url: "https://example.com" },
  browser_resize: { width: 800, height: 600 },
  browser_handle_dialog: { accept: true, promptText: "example" },
}
const cases: {
  name: string
  schema: Record<string, unknown>
  valid: Record<string, unknown>
  invalid: Record<string, unknown>[]
  unsupported?: string
}[] = schemas.map((fixture) => ({
  name: fixture.server + "/" + fixture.name,
  schema: fixture.inputSchema,
  valid: valid[fixture.name],
  invalid: [{}, { ...valid[fixture.name], [fixture.inputSchema.required[0]]: null }],
}))
for (const draft of ["draft-04", "draft-06", "draft-07", "draft/2020-12"]) {
  for (const protocol of ["http", "https"]) {
    for (const fragment of ["", "#"]) {
      const dialect = protocol + "://json-schema.org/" + draft + "/schema" + fragment
      cases.push({
        name: dialect,
        schema: {
          $schema: dialect,
          type: "object",
          properties: {
            value: { $ref: "#/definitions/positive" },
            pair: {
              type: "array",
              ...(draft === "draft/2020-12"
                ? { prefixItems: [{ type: "string" }], items: false }
                : { items: [{ type: "string" }], additionalItems: false }),
            },
          },
          definitions: {
            positive: {
              type: "number",
              ...(draft === "draft-04" ? { minimum: 0, exclusiveMinimum: true } : { exclusiveMinimum: 0 }),
            },
          },
          required: ["value"],
          additionalProperties: false,
        },
        valid: { value: 1, pair: ["ok"] },
        invalid: [{ value: 0 }, { value: "1" }, { value: 1, pair: [42] }, { value: 1, pair: ["ok", "extra"] }],
      })
    }
  }
}
cases.push({
  name: "unknown annotations with real validation keywords",
  schema: {
    type: "object",
    "x-ui": { widget: "form" },
    markdownDescription: "**example**",
    properties: { a: { type: "string", markdownDescription: "A" }, b: { type: "string", "x-label": "B" } },
    dependentRequired: { a: ["b"] },
    unevaluatedProperties: false,
  },
  valid: { a: "a", b: "b" },
  invalid: [{ a: "a" }, { a: 3, b: "b" }, { extra: true }],
})
for (const dialect of ["https://invalid.test/schema", "https://json-schema.org/draft-07/schema#not-a-dialect"]) {
  cases.push({
    name: dialect,
    schema: { type: "object", $schema: dialect },
    valid: {},
    invalid: [],
    unsupported: dialect,
  })
}
for (const scenario of cases) {
  const schema = scenario.schema
  const approvals: PermissionV2.AssertInput[] = []
  const it = testEffect(
    AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, ToolRegistry.node, MCP.node]), [
      [
        Config.node,
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: new Config.Info({
                    mcp: new ConfigMCP.Info({
                      servers: {
                        fixture: new ConfigMCP.Local({
                          type: "local",
                          command: [process.execPath, path.join(directory, "mcp-canonical-stdio.ts")],
                          environment: { MCP_TEST_SCHEMA: JSON.stringify(schema), MCP_TEST_APPROVAL: "1" },
                        }),
                      },
                    }),
                  }),
                }),
              ]),
          }),
        ),
      ],
      [
        Location.node,
        Layer.succeed(
          Location.Service,
          Location.Service.of({ directory, project: { id: ProjectV2.ID.global, directory } }),
        ),
      ],
      [
        PermissionV2.node,
        Layer.mock(PermissionV2.Service, {
          assert: (input) =>
            Effect.sync(() => {
              approvals.push(input)
            }),
        }),
      ],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ]),
  )
  it.live(
    "V-r1 " + scenario.name,
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const call = (input: Record<string, unknown>) =>
          executeTool(registry, {
            sessionID: SessionV2.ID.make("ses_compatibility"),
            ...toolIdentity,
            call: { type: "tool-call", id: "compatibility", name: "mcp_fixture_echo", input },
          })
        for (const input of scenario.invalid) {
          expect((yield* call(input)).type).toBe("error")
          expect(approvals).toHaveLength(0)
        }
        const output = yield* call(scenario.valid)
        if (scenario.unsupported) {
          expect(output.type).toBe("error")
          expect(JSON.stringify(output)).toContain(scenario.unsupported)
          expect(approvals).toHaveLength(0)
          return
        }
        expect(output).toEqual({ type: "text", value: JSON.stringify({ arguments: scenario.valid, calls: 1 }) })
        expect(approvals).toHaveLength(1)
      }),
    30000,
  )
}
