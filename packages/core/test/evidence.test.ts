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
      expect(ids[0]).toBe(Evidence.reference(session, file))
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

test("literal search pages preserve Unicode byte boundaries and do not duplicate overlap matches", async () => {
  await using root = await tmpdir()
  const directory = path.join(root.path, "tool-output")
  await fs.mkdir(directory)
  const file = path.join(directory, "tool_unicode")
  const text = "🙂中文🙂中文abc🙂xyz".repeat(45)
  await fs.writeFile(file, text)
  await Effect.runPromise(
    Effect.gen(function* () {
      const evidence = yield* Evidence.Service
      const session = SessionV2.ID.make("ses_unicode")
      const [id] = yield* evidence.retain(session, "unicode", [file])
      for (const query of ["🙂", "中文", "文🙂中", "abc🙂x", "missing"]) {
        const expected: number[] = []
        for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + query.length))
          expected.push(Buffer.byteLength(text.slice(0, at)))
        for (const length of [13, 27, 1024]) {
          const matches: number[] = []
          let offset = 0
          for (let page = 0; page < 500; page++) {
            const result = yield* evidence.read(session, id, offset, length, query)
            matches.push(...(result.matches ?? []).map((match) => match.offset))
            if (result.nextOffset === undefined) break
            expect(result.nextOffset).toBeGreaterThan(offset)
            offset = result.nextOffset
          }
          expect(matches).toEqual(expected)
        }
      }
    }).pipe(
      Effect.provide(AppNodeBuilder.build(Evidence.node, [[Global.node, Global.layerWith({ data: root.path })]])),
    ),
  )
})
