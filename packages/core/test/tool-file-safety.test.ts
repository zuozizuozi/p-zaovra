import { expect, test } from "bun:test"
import path from "node:path"
import { Effect, Fiber, Layer, Schedule } from "effect"
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
import { ReadTool } from "@zaovra-ai/core/tool/read"
import { EditTool } from "@zaovra-ai/core/tool/edit"
import { WriteTool } from "@zaovra-ai/core/tool/write"
import { ApplyPatchTool } from "@zaovra-ai/core/tool/apply-patch"
import { ToolRegistry } from "@zaovra-ai/core/tool/registry"
import { ToolOutputStore } from "@zaovra-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { settleTool, toolIdentity } from "./lib/tool"

test("real file tools preserve safe permission feedback and partial mutation facts", async () => {
  await using root = await tmpdir()
  const sessionID = SessionV2.ID.make("ses_real_file_permission")
  await Bun.write(path.join(root.path, "existing.txt"), "before")
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
      const registry = yield* ToolRegistry.Service
      const permission = yield* PermissionV2.Service
      const calls = [
        { name: "read", input: { path: "existing.txt" } },
        { name: "edit", input: { path: "existing.txt", oldString: "before", newString: "after" } },
        { name: "write", input: { path: "created.txt", content: "new" } },
        {
          name: "apply_patch",
          input: { patchText: "*** Begin Patch\n*** Add File: patched.txt\n+new\n*** End Patch" },
        },
      ]
      for (const mode of ["deny", "ask"] as const) {
        yield* agents.transform((draft) =>
          draft.update(toolIdentity.agent, (agent) => {
            agent.permissions = [{ action: "*", resource: "*", effect: mode }]
          }),
        )
        for (const call of calls) {
          const fiber = yield* settleTool(registry, {
            sessionID,
            ...toolIdentity,
            inputModalities: ["text"],
            call: { type: "tool-call", id: `${mode}-${call.name}`, ...call },
          }).pipe(Effect.forkChild)
          if (mode === "ask") {
            const wait = Effect.gen(function* () {
              return (yield* permission.list())[0]
            })
            const request = yield* wait.pipe(
              Effect.repeat({ until: (value) => value !== undefined, schedule: Schedule.spaced("10 millis") }),
            )
            yield* permission.reply({
              requestID: request!.id,
              reply: "reject",
              message: "Keep the original; inspect another file.",
            })
          }
          const result = yield* Fiber.join(fiber)
          expect(result.result.type).toBe("error")
          expect(result.result.value).toContain(mode === "deny" ? "permission policy blocked" : "Keep the original")
          expect(result.errorMetadata).toEqual({
            phase: "permission",
            reason: `PermissionV2.${mode === "deny" ? "Blocked" : "Corrected"}Error`,
          })
          expect(yield* Effect.promise(() => Bun.file(path.join(root.path, "existing.txt")).text())).toBe("before")
          for (const file of ["created.txt", "patched.txt"])
            expect(yield* Effect.promise(() => Bun.file(path.join(root.path, file)).exists())).toBe(false)
        }
      }
      yield* agents.transform((draft) =>
        draft.update(toolIdentity.agent, (agent) => {
          agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
        }),
      )
      const partial = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "partial",
          name: "apply_patch",
          input: {
            patchText:
              "*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: existing.txt\n+bad\n*** End Patch",
          },
        },
      })
      expect(partial.result.value).toContain("Applied: first.txt")
      expect(partial.errorMetadata).toEqual({
        phase: "mutation",
        reason: "partial-application",
        appliedFiles: '["first.txt"]',
      })
      expect(yield* Effect.promise(() => Bun.file(path.join(root.path, "first.txt")).text())).toBe("first\n")
      expect(yield* Effect.promise(() => Bun.file(path.join(root.path, "existing.txt")).text())).toBe("before")
    }).pipe(
      Effect.scoped,
      Effect.provide(
        AppNodeBuilder.build(
          LayerNode.group([
            ReadTool.node,
            EditTool.node,
            WriteTool.node,
            ApplyPatchTool.node,
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
