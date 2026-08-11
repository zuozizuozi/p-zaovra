import { describe, expect, test } from "bun:test"
import path from "node:path"

const source = (file: string) => Bun.file(path.join(import.meta.dir, "../../src", file)).text()
const workspace = (file: string) => Bun.file(path.join(import.meta.dir, "../../../..", file)).text()

describe("Session V2 production wiring", () => {
  test("does not assemble the legacy Session HttpApi or loop runtime", async () => {
    const [api, server, runtime] = await Promise.all([
      source("server/routes/instance/httpapi/api.ts"),
      source("server/routes/instance/httpapi/server.ts"),
      source("effect/app-runtime.ts"),
    ])

    expect(api).not.toContain("SessionApi")
    expect(server).not.toContain("sessionHandlers")
    expect(server).not.toContain("SessionPrompt")
    expect(runtime).not.toContain("SessionPrompt")
    ;[
      /\bSession\.node\b/,
      /\bTodo\.node\b/,
      /\bSessionStatus\.node\b/,
      /\bAuth\.node\b/,
      /\bProviderAuth\.node\b/,
      /\bMCP\.node\b/,
      /\bMcpAuth\.node\b/,
      /\bCommand\.node\b/,
      /\bPermission\.node\b/,
      /\bQuestion\.node\b/,
    ].forEach((legacyNode) => {
      expect(server).not.toMatch(legacyNode)
      expect(runtime).not.toMatch(legacyNode)
    })
  })

  test("does not expose experimental V1 session routes or plugin client calls", async () => {
    const [group, handler, copilot] = await Promise.all([
      source("server/routes/instance/httpapi/groups/experimental.ts"),
      source("server/routes/instance/httpapi/handlers/experimental.ts"),
      source("plugin/github-copilot/copilot.ts"),
    ])

    expect(group).not.toContain("experimental.session")
    expect(group).not.toContain("sessionBackground")
    expect(handler).not.toContain("Session.Service")
    expect(copilot).not.toContain("sdk.session")
  })

  test("does not mount legacy permission, question, command, tool, or MCP APIs", async () => {
    const api = await source("server/routes/instance/httpapi/api.ts")
    const server = await source("server/routes/instance/httpapi/server.ts")

    ;["SessionApi", "PermissionApi", "QuestionApi", "CommandApi", "ToolApi", "McpApi"].forEach(
      (legacyApi) => {
        expect(api).not.toContain(legacyApi)
        expect(server).not.toContain(`${legacyApi.slice(0, -3).toLowerCase()}Handlers`)
      },
    )
  })

  test("keeps the generated SDK and formal Zaovra sources free of V1 Session calls", async () => {
    const generated = await workspace("packages/sdk/js/src/v2/gen/sdk.gen.ts")
    const files = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: path.join(import.meta.dir, "../../src") }))
    const production = await Promise.all(files.map((file) => source(file)))

    expect(generated).not.toContain('url: "/session')
    expect(generated).not.toContain('url: "/experimental/session')
    expect(generated).not.toContain('url: "/permission')
    expect(generated).not.toContain('url: "/question')
    expect(generated).not.toContain('url: "/command')
    expect(generated).not.toContain('url: "/mcp')
    expect(production.join("\n")).not.toMatch(/\b(?:sdk|client)\.session\./)
  })

  test("physically removes retired runtime adapters and the root legacy SDK", async () => {
    const retired = [
      "packages/zaovra/src/session/index.ts",
      "packages/zaovra/src/mcp/index.ts",
      "packages/zaovra/src/auth/index.ts",
      "packages/zaovra/src/question/index.ts",
      "packages/zaovra/src/command/index.ts",
      "packages/zaovra/src/permission/evaluate.ts",
      "packages/zaovra/src/effect/bootstrap-runtime.ts",
      "packages/zaovra/src/provider/auth.ts",
      "packages/zaovra/src/share/share-next.ts",
      "packages/zaovra/src/share/session.ts",
      "packages/sdk/js/src/gen/sdk.gen.ts",
      "packages/sdk/js/src/gen/types.gen.ts",
    ]

    expect(await Promise.all(retired.map((file) => Bun.file(path.join(import.meta.dir, "../../../..", file)).exists()))).toEqual(
      retired.map(() => false),
    )
    expect(await workspace("packages/sdk/js/src/client.ts")).toContain('export * from "./v2/client.js"')
    expect(await workspace("packages/sdk/js/src/server.ts")).toContain('export * from "./v2/server.js"')
  })

  test("keeps the formal product free of retired execution services", async () => {
    const files = Array.from(new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: path.join(import.meta.dir, "../../src") }))
    const production = (await Promise.all(files.map((file) => source(file)))).join("\n")
    const permissionRules = await source("permission/index.ts")

    expect(production).not.toMatch(/@zaovra-ai\/core\/v1\/(?:session|permission)/)
    expect(production).not.toMatch(/@[\/]?(?:session|mcp|auth|question)(?:[\/\"])/)
    expect(production).not.toContain("SessionPrompt")
    expect(production).not.toContain("McpAuth.node")
    expect(permissionRules).not.toContain("Context.Service")
    expect(permissionRules).not.toContain("readonly ask:")
    expect(permissionRules).not.toContain("readonly reply:")
  })
})
