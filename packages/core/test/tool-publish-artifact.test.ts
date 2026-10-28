import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { Location } from "../src/location"
import { PermissionV2 } from "../src/permission"
import { AbsolutePath } from "../src/schema"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { SessionMessage } from "../src/session/message"
import { SessionSchema } from "../src/session/schema"
import { SessionTable, SessionMessageTable } from "../src/session/sql"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { PublishArtifactTool } from "../src/tool/publish-artifact"
import { FileBackup } from "../src/file-backup"
import { ToolRegistry } from "../src/tool/registry"
import { ToolOutputStore } from "../src/tool-output-store"
import { tmpdir } from "./fixture/tmpdir"
import { location } from "./fixture/location"
import { settleTool, toolIdentity } from "./lib/tool"

for (const scenario of ["valid", "denied", "stale", "failed", "unverified", "capacity"])
  test(`367 publish_artifact leaf validates actual candidate and preserves final: ${scenario}`, async () => {
    await using dir = await tmpdir()
    const candidate = path.join(dir.path, "candidate.json")
    const final = path.join(dir.path, "final.json")
    const expected = scenario === "capacity" ? [1, 2, "x".repeat(FileBackup.MAX_FILE_BYTES)] : [1, 2]
    await Bun.write(candidate, JSON.stringify(expected))
    await Bun.write(final, "[1]")
    // This acceptance check actually parses the candidate and checks its contents.
    expect(await Bun.file(candidate).json()).toEqual(expected)
    const digest = createHash("sha256")
      .update(await Bun.file(candidate).bytes())
      .digest("hex")
    const previous = createHash("sha256").update("[1]").digest("hex")
    const sessionID = SessionSchema.ID.make("ses_publish")
    const time = { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) }
    const messages: SessionMessage.Message[] = [
      { type: "user", id: SessionMessage.ID.make("msg_publish_user"), text: "交付 final.json。", time },
      {
        type: "assistant",
        id: SessionMessage.ID.make("msg_publish_check"),
        agent: "build",
        time,
        finish: "stop",
        model: { id: ModelV2.ID.make("offline"), providerID: ProviderV2.ID.make("offline") },
        content: [
          {
            type: "tool",
            id: "candidate-check",
            name: "bash",
            time,
            state: {
              status: "completed",
              input: {},
              content: [],
              structured: {
                verification: {
                  kind: "test",
                  command: "check candidate",
                  callID: "candidate-check",
                  exit: scenario === "failed" ? 1 : 0,
                  targets: [{ path: candidate, digest }],
                  requirements: ["JSON array containing both requested values"],
                },
              },
            },
          },
        ],
      },
    ]
    if (scenario === "stale") await Bun.write(candidate, "[3]")
    const permission = Layer.mock(PermissionV2.Service, {
      assert: () => (scenario === "denied" ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
    })
    const layer = AppNodeBuilder.build(
      LayerNode.group([PublishArtifactTool.node, ToolRegistry.node, ToolRegistry.toolsNode, Database.node]),
      [
        [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(dir.path) }))],
        [PermissionV2.node, permission],
        [Database.node, Database.layerFromPath(":memory:")],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ],
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make(dir.path), sandboxes: [] })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "publish",
            directory: dir.path,
            title: "publish",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        for (const [index, message] of messages.entries())
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: message.id,
              type: message.type,
              session_id: sessionID,
              seq: index + 1,
              data: Schema.encodeSync(SessionMessage.Message)(message),
            })
            .run()
            .pipe(Effect.orDie)
        return yield* settleTool(yield* ToolRegistry.Service, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "publish",
            name: "publish_artifact",
            input: {
              candidate,
              path: final,
              check: scenario === "unverified" ? "unknown-check" : "candidate-check",
              expectedDigest: previous,
            },
          },
        })
      }).pipe(Effect.provide(layer), Effect.scoped),
    )
    const success = scenario === "valid" || scenario === "capacity"
    expect(result.result.type).toBe(success ? "text" : "error")
    expect(await Bun.file(final).json()).toEqual(success ? expected : [1])
    if (success) expect(await Bun.file(final + `.verified-${previous}.bak`).text()).toBe("[1]")
    if (scenario === "capacity")
      expect(result.result).toMatchObject({ type: "text", value: expect.stringContaining("cannot be undone") })
  })
