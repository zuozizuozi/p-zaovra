import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Evidence } from "@zaovra-ai/core/evidence"
import { Global } from "@zaovra-ai/core/global"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { SessionV2 } from "@zaovra-ai/core/session"
import { tmpdir } from "./fixture/tmpdir"

test("evidence is stable, session-owned, paginated and searchable without rerunning a producer", async () => {
  await using root = await tmpdir()
  const directory = path.join(root.path, "tool-output")
  await fs.mkdir(directory)
  const file = path.join(directory, "tool_log")
  await fs.writeFile(file, "前文\n" + "a".repeat(35000) + "needle\nlast line")
  await Effect.runPromise(
    Effect.gen(function* () {
      const evidence = yield* Evidence.Service
      const session = SessionV2.ID.make("ses_evidence")
      const ids = yield* evidence.retain(session, "call", [file])
      expect(yield* evidence.retain(session, "call", [file])).toEqual(ids)
      const first = yield* evidence.read(session, ids[0], 0, 32768)
      expect(first.text.startsWith("前文")).toBe(true)
      expect(first.producer).toBe("complete")
      expect(first.nextOffset).toBeDefined()
      const tail = yield* evidence.read(session, ids[0], first.nextOffset!, 32768, "needle")
      expect(tail.matches?.[0]?.text).toContain("needle")
      expect(tail.nextOffset).toBeUndefined()
      const denied = yield* Effect.result(evidence.read(SessionV2.ID.make("ses_other"), ids[0], 0, 100))
      expect(denied._tag).toBe("Failure")
      const traversal = yield* Effect.result(evidence.read(session, "../../secret", 0, 100))
      expect(traversal._tag).toBe("Failure")
      yield* Effect.promise(() => fs.rm(file))
      expect((yield* Effect.result(evidence.read(session, ids[0], 0, 100)))._tag).toBe("Failure")
    }).pipe(
      Effect.provide(AppNodeBuilder.build(Evidence.node, [[Global.node, Global.layerWith({ data: root.path })]])),
    ),
  )
})
