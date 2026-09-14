import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { DateTime, Effect, Layer } from "effect"
import { SessionAttachments } from "@zaovra-ai/core/session/attachments"
import { SessionMessage } from "@zaovra-ai/core/session/message"
import { SessionV2 } from "@zaovra-ai/core/session"
import { AgentV2 } from "@zaovra-ai/core/agent"
import { Global } from "@zaovra-ai/core/global"
import { Location } from "@zaovra-ai/core/location"
import { AbsolutePath } from "@zaovra-ai/core/schema"
import { PermissionV2 } from "@zaovra-ai/core/permission"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { tmpdir } from "./fixture/tmpdir"

test("attachments materialize real contents once, list directories and report unresolved sources", async () => {
  await using root = await tmpdir()
  const file = path.join(root.path, "文件 a.txt")
  await fs.writeFile(file, "original")
  const requests: string[] = []
  const permission = Layer.mock(PermissionV2.Service, {
    assert: (input) =>
      Effect.sync(() => {
        requests.push(input.action)
      }),
  })
  const layer = AppNodeBuilder.build(SessionAttachments.node, [
    [Global.node, Global.layerWith({ data: path.join(root.path, "data") })],
    [Location.node, Location.boundNode({ directory: AbsolutePath.make(root.path) })],
    [PermissionV2.node, permission],
  ])
  await Effect.runPromise(
    Effect.gen(function* () {
      const attachments = yield* SessionAttachments.Service
      const message: SessionMessage.User = {
        id: SessionMessage.ID.make("msg_files"),
        type: "user",
        time: { created: DateTime.makeUnsafe(1) },
        text: "Read",
        files: [{ uri: pathToFileURL(file).href, mime: "text/plain" }],
      }
      const first = yield* attachments.materialize(SessionV2.ID.make("ses_files"), AgentV2.ID.make("build"), [message])
      expect(first[0].type === "user" && first[0].files?.[0].uri).toContain(Buffer.from("original").toString("base64"))
      yield* Effect.promise(() => fs.writeFile(file, "changed"))
      expect(
        yield* attachments.materialize(SessionV2.ID.make("ses_files"), AgentV2.ID.make("build"), [message]),
      ).toEqual(first)
      expect(requests.filter((action) => action === "read")).toHaveLength(2)
      const directory = yield* attachments.materialize(SessionV2.ID.make("ses_files"), AgentV2.ID.make("build"), [
        {
          ...message,
          id: SessionMessage.ID.make("msg_directory"),
          files: [{ uri: root.path, mime: "application/x-directory" }],
        },
      ])
      const listing = directory[0].type === "user" ? directory[0].files?.[0].uri : undefined
      expect(Buffer.from(listing!.split(",")[1], "base64").toString()).toContain("文件 a.txt")
      const remote = yield* attachments.materialize(SessionV2.ID.make("ses_files"), AgentV2.ID.make("build"), [
        {
          ...message,
          id: SessionMessage.ID.make("msg_remote"),
          files: [{ uri: "https://invalid.example/file", mime: "text/plain" }],
        },
      ])
      const unavailable = remote[0].type === "user" ? remote[0].files?.[0].uri : undefined
      expect(Buffer.from(unavailable!.split(",")[1], "base64").toString()).toContain("Attachment unavailable")
    }).pipe(Effect.provide(layer)),
  )
})
