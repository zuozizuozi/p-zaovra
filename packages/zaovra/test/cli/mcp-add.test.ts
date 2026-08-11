import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../lib/cli-process"

describe("zaovra mcp add (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "adds a remote server with HTTP headers",
    ({ home, zaovra }) =>
      Effect.gen(function* () {
        const result = yield* zaovra.spawn([
          "mcp",
          "add",
          "github",
          "--url",
          "https://example.com/mcp",
          "--header",
          "Authorization=Bearer {env:GITHUB_TOKEN}",
          "--header",
          "X-Option=one=two",
        ])
        zaovra.expectExit(result, 0)

        const config = yield* Effect.promise(() => Bun.file(path.join(home, ".config", "zaovra", "zaovra.json")).json())
        expect(config.mcp.servers.github).toEqual({
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer {env:GITHUB_TOKEN}",
            "X-Option": "one=two",
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a local server while preserving argv and environment values",
    ({ home, zaovra }) =>
      Effect.gen(function* () {
        const result = yield* zaovra.spawn([
          "mcp",
          "add",
          "local",
          "--env",
          "API_KEY=secret",
          "--env",
          "VALUE=one=two",
          "--",
          "npx",
          "-y",
          "@example/server",
          "--label",
          "two words",
        ])
        zaovra.expectExit(result, 0)

        const config = yield* Effect.promise(() => Bun.file(path.join(home, ".config", "zaovra", "zaovra.json")).json())
        expect(config.mcp.servers.local).toEqual({
          type: "local",
          command: ["npx", "-y", "@example/server", "--label", "two words"],
          environment: {
            API_KEY: "secret",
            VALUE: "one=two",
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails explicit auth when the V2 MCP server is not configured",
    ({ zaovra }) =>
      Effect.gen(function* () {
        const result = yield* zaovra.spawn(["mcp", "auth", "missing"])
        zaovra.expectExit(result, 1)
        expect(result.stderr + result.stdout).toContain("MCP server not found: missing")
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails explicit logout when no V2 MCP credential exists",
    ({ zaovra }) =>
      Effect.gen(function* () {
        const result = yield* zaovra.spawn(["mcp", "logout", "missing"])
        zaovra.expectExit(result, 1)
        expect(result.stderr + result.stdout).toContain("No V2 MCP credential found for: missing")
      }),
    60_000,
  )
})
