import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { Config } from "@zaovra-ai/core/config"
import { Database } from "@zaovra-ai/core/database/database"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { Global } from "@zaovra-ai/core/global"
import { Location } from "@zaovra-ai/core/location"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { Project } from "@zaovra-ai/core/project"
import { ProjectTable } from "@zaovra-ai/core/project/sql"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { SessionV2 } from "@zaovra-ai/core/session"
import { SessionTable } from "@zaovra-ai/core/session/sql"
import { BashTool } from "@zaovra-ai/core/tool/bash"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { ToolOutputStore } from "@zaovra-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { probeShell } from "./fixture/probe-shell"
import { settleTool, toolIdentity } from "./lib/tool"

test("real Bash permission denial prevents a process while allowed success and nonzero exits still execute", async () => {
  await using root = await tmpdir()
  const sessionID = SessionV2.ID.make("ses_real_bash_permission")
  const marker = path.join(root.path, "executed.txt")
  const probe = await probeShell(root.path)
  const configPath = path.join(root.path, "zaovra.json")
  await Bun.write(configPath, JSON.stringify({ shell: probe.executable }))
  await Bun.write(
    path.join(root.path, "probe.mjs"),
    "import { writeFileSync } from 'node:fs'; writeFileSync('executed.txt', process.argv[2]); process.exitCode = Number(process.argv[2]);",
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({
          id: Project.ID.global,
          worktree: AbsolutePath.make(root.path),
          sandboxes: [],
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "permission",
          directory: root.path,
          title: "permission",
          version: "test",
          agent: "build",
        })
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((draft) =>
        draft.update(toolIdentity.agent, (agent) => {
          agent.permissions = [{ action: "bash", resource: "*", effect: "deny" }]
        }),
      )
      const registry = yield* ToolRegistry.Service
      const denied = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "denied", name: "bash", input: { command: "bun probe.mjs 0" } },
      })
      expect(denied.result.type).toBe("error")
      expect(denied.result.value).toContain("Command not executed: permission policy blocked")
      expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(probe.marker).exists())).toBe(false)
      yield* Effect.promise(() => fs.unlink(configPath))
      const permission = yield* PermissionV2.Service
      expect(yield* permission.list()).toEqual([])

      yield* agents.transform((draft) =>
        draft.update(toolIdentity.agent, (agent) => {
          agent.permissions = [{ action: "bash", resource: "*", effect: "allow" }]
        }),
      )
      for (const exit of [0, 7]) {
        const allowed = yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: `allowed-${exit}`, name: "bash", input: { command: `bun probe.mjs ${exit}` } },
        })
        expect(allowed.output?.structured).toMatchObject({ exit })
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe(String(exit))
        expect(JSON.stringify(allowed.result)).not.toContain("permission policy blocked")
      }
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
          ]),
          [
            [
              Location.node,
              Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(root.path) })),
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
            [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ],
        ),
      ),
    ),
  )
}, 30_000)
