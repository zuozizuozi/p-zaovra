import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect, Exit, Fiber, Layer, Option } from "effect"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { AISDK } from "@zaovra-ai/core/aisdk"
import { Catalog } from "@zaovra-ai/core/catalog"
import { CommandV2 } from "@zaovra-ai/core/command"
import { Config } from "@zaovra-ai/core/config"
import { ConfigAgentPlugin } from "@zaovra-ai/core/config/plugin/agent"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { Global } from "@zaovra-ai/core/global"
import { Integration } from "@zaovra-ai/core/integration"
import { Location } from "@zaovra-ai/core/location"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { PluginV2 } from "@zaovra-ai/core/plugin"
import { AgentPlugin } from "@zaovra-ai/core/plugin/agent"
import { PluginHost } from "@zaovra-ai/core/plugin/host"
import { Project } from "@zaovra-ai/core/project"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { Reference } from "@zaovra-ai/core/reference"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionTable } from "@zaovra-ai/core/session/sql"
import { SkillV2 } from "@zaovra-ai/core/skill"
import { BashTool } from "@zaovra-ai/core/tool/bash"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { ToolOutputStore } from "@zaovra-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { probeShell } from "./fixture/probe-shell"
import { tmpdir } from "./fixture/tmpdir"
import { settleTool, toolIdentity } from "./lib/tool"

const scenarios: {
  name: string
  command: string
  config: Record<string, unknown> | ((workspace: string) => Record<string, unknown>)
  ask?: "bash" | "external_directory"
  denied?: boolean
  changedCwd?: boolean
}[] = [
  { name: "default pipe", command: "ls | grep x", config: {} },
  { name: "default redirect", command: "echo a > f", config: {} },
  { name: "default inline interpreter", command: "python -c 'print(1)'", config: {} },
  { name: "default paired quote", command: 'echo "a b"', config: {} },
  { name: "default internal cd", command: "cd sub && ls", config: {} },
  { name: "legacy all allow", command: "cat $HOME/f | sort", config: { permission: { "*": "allow" } } },
  {
    name: "native all allow",
    command: "cat $HOME/f | sort",
    config: { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
  },
  {
    name: "agent-specific shell allow",
    command: "cat $HOME/f",
    config: { agents: { build: { permissions: [{ action: "bash", resource: "*", effect: "allow" }] } } },
  },
  {
    name: "explicit directory allow",
    command: "cat $HOME/f",
    config: { permissions: [{ action: "external_directory", resource: "*", effect: "allow" }] },
  },
  { name: "default unresolved path", command: 'cat "$HOME/f"', config: {}, ask: "bash" },
  { name: "default literal external path", command: "cat ../outside/f | sort", config: {}, ask: "external_directory" },
  {
    name: "explicit allow with directory deny",
    command: "cat $HOME/f",
    config: {
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "external_directory", resource: "*", effect: "deny" },
      ],
    },
    denied: true,
  },
  {
    name: "explicit shell deny",
    command: "ls | grep x",
    config: { permissions: [{ action: "bash", resource: "*", effect: "deny" }] },
    denied: true,
  },
  ...(["ask", "deny"] as const).map((effect) => ({
    name: `515 broad allow with narrow directory ${effect}`,
    command: "cat $HOME/f",
    config: {
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "external_directory", resource: "/private/*", effect },
      ],
    },
    denied: true,
  })),
  ...[
    "cd sub && cat ../../private/f",
    "pushd sub && cat ../../private/f",
    "Set-Location sub; Get-Content ../../private/f",
  ].map((command) => ({
    name: `515 changed cwd cannot bypass its actual target deny: ${command}`,
    command,
    config: (workspace: string) => ({
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        {
          action: "external_directory",
          resource: path.join(workspace, "../private/*").replaceAll("\\", "/"),
          effect: "deny",
        },
      ],
    }),
    changedCwd: true,
    denied: true,
  })),
  ...[
    "cd sub && cd ../../private && ls",
    "pushd sub && pushd ../../private && ls",
    "Set-Location sub; Set-Location ../../private; Get-ChildItem",
    "Push-Location sub; Push-Location ../../private; Get-ChildItem",
    "popd && cd sub && ls",
    "pushd sub && popd && cd sub && ls",
    "Pop-Location; Set-Location sub; Get-ChildItem",
    "Push-Location sub; Pop-Location; Set-Location sub; Get-ChildItem",
  ].map((command) => ({
    name: `519 consecutive or restored cwd cannot dispatch under a narrow directory deny: ${command}`,
    command,
    config: (workspace: string) => ({
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        {
          action: "external_directory",
          resource: path.join(workspace, "../private/*").replaceAll("\\", "/"),
          effect: "deny",
        },
      ],
    }),
    changedCwd: true,
    denied: true,
  })),
  ...["cd sub", "cd sub && make"].map((command) => ({
    name: `519 single cwd change remains allowed: ${command}`,
    command,
    config: {},
  })),
  ...["cd sub && cd ../../private && ls", "Set-Location sub; Set-Location ../../private; Get-ChildItem"].map(
    (command) => ({
      name: `519 harness universal allow preserves repeated directory changes: ${command}`,
      command,
      config: { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    }),
  ),
  ...["ls | grep x", "echo a > f", "cd sub && make"].map((command) => ({
    name: `515 harness universal allow preserves ${command}`,
    command,
    config: { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
  })),
]

for (const scenario of scenarios) {
  test(`511 real built-in Agent/Config/Bash permissions: ${scenario.name}`, async () => {
    await using root = await tmpdir()
    const workspace = path.join(root.path, scenario.changedCwd ? "sandbox/work" : "work")
    await fs.mkdir(path.join(workspace, "sub"), { recursive: true })
    await Bun.write(path.join(root.path, "outside/f"), "harmless external operand")
    if (scenario.changedCwd) {
      await Bun.write(path.join(root.path, "private/f"), "old cwd target")
      await Bun.write(path.join(root.path, "sandbox/private/f"), "actual changed cwd target")
    }
    const probe = await probeShell(workspace)
    const sessionID = SessionV2.ID.make("ses_shell_confirmation_511")
    const config = Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: Option.getOrThrow(
              Config.decode({
                ...(typeof scenario.config === "function" ? scenario.config(workspace) : scenario.config),
                shell: probe.executable,
              }),
            ),
          }),
        ]),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* Database.Service
        yield* database.db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make(workspace), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* database.db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "confirmation",
            directory: workspace,
            title: "confirmation",
            version: "test",
            agent: "build",
          })
          .run()
          .pipe(Effect.orDie)
        const agents = yield* AgentV2.Service
        const plugin = yield* PluginV2.Service
        const context = yield* PluginHost.make(plugin)
        yield* AgentPlugin.Plugin.effect(context)
        yield* ConfigAgentPlugin.Plugin.effect(context)
        yield* agents.reload()
        const permissions = yield* PermissionV2.Service
        const registry = yield* ToolRegistry.Service
        // The real leaf reaches a harmless executable only after authorization.
        // These assertions observe real pending requests, not a mocked assert().
        const fiber = yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "confirmation", name: "bash", input: { command: scenario.command } },
        }).pipe(Effect.exit, Effect.forkScoped)
        for (let attempt = 0; attempt < 200; attempt++) {
          if ((yield* permissions.forSession(sessionID)).length || fiber.pollUnsafe() !== undefined) break
          yield* Effect.sleep("10 millis")
        }
        const pending = yield* permissions.forSession(sessionID)
        expect(pending.map((item) => item.action)).toEqual(scenario.ask ? [scenario.ask] : [])
        for (const item of pending) yield* permissions.reply({ requestID: item.id, reply: "reject" })
        const result = yield* Fiber.join(fiber)
        expect(Exit.isSuccess(result)).toBe(!scenario.ask)
        if (Exit.isSuccess(result)) expect(result.value.result.type).toBe(scenario.denied ? "error" : "content")
        expect(yield* Effect.promise(() => Bun.file(probe.marker).exists())).toBe(!scenario.ask && !scenario.denied)
        expect(yield* permissions.list()).toEqual([])
      }).pipe(
        Effect.scoped,
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              BashTool.node,
              ToolRegistry.node,
              ToolRegistry.toolsNode,
              Database.node,
              AgentV2.node,
              PermissionV2.node,
              Config.node,
              Global.node,
              FSUtil.node,
              PluginV2.node,
              AISDK.node,
              Catalog.node,
              CommandV2.node,
              Integration.node,
              Reference.node,
              SkillV2.node,
            ]),
            [
              [
                Location.node,
                Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(workspace) })),
                ),
              ],
              [
                Global.node,
                Global.layerWith({
                  data: path.join(root.path, "data"),
                  config: path.join(root.path, "config"),
                  state: path.join(root.path, "state"),
                }),
              ],
              [Config.node, Layer.succeed(Config.Service, config)],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ],
          ),
        ),
      ),
    )
  }, 20_000)
}
