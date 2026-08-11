import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@zaovra-ai/core/effect/app-node-builder"
import { Database } from "@zaovra-ai/core/database/database"
import { LayerNode } from "@zaovra-ai/core/effect/layer-node"
import { FSUtil } from "@zaovra-ai/core/fs-util"
import { Global } from "@zaovra-ai/core/global"
import { WorkArtifact } from "@zaovra-ai/core/work/artifact"
import { WorkArtifactTable } from "@zaovra-ai/core/work/sql"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("WorkArtifact", () => {
  it.live("stores, deduplicates, and validates content-addressed merge input", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const artifacts = yield* WorkArtifact.Service
          const first = yield* artifacts.put("diff --git a/file b/file\n")
          const second = yield* artifacts.put("diff --git a/file b/file\n")

          expect(second).toEqual(first)
          expect(yield* artifacts.get(first)).toBe("diff --git a/file b/file\n")

          yield* Effect.promise(() =>
            Bun.write(
              path.join(root.path, "work", "artifacts", first.digest.slice(0, 2), `${first.digest}.patch`),
              "corrupt",
            ),
          )
          expect(yield* artifacts.get(first).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([Database.node, FSUtil.node, WorkArtifact.node]), [
              [Database.node, Database.layerFromPath(path.join(root.path, "artifact-test.db"))],
              [Global.node, Global.layerWith({ data: root.path })],
            ]),
          ),
        ),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("retains referenced artifacts and safely collects only unreferenced content", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const artifacts = yield* WorkArtifact.Service
          const retained = yield* artifacts.put("retained patch")
          const orphan = yield* artifacts.put("orphan patch")
          yield* artifacts.retain(retained, { type: "test", id: "owner" })
          const db = (yield* Database.Service).db
          yield* db.update(WorkArtifactTable).set({ time_accessed: 0 }).run().pipe(Effect.orDie)

          expect(yield* artifacts.inventory).toMatchObject([
            { artifact: { digest: retained.digest }, referenceCount: 1, state: "active" },
            { artifact: { digest: orphan.digest }, referenceCount: 0, state: "active" },
          ])
          expect(yield* artifacts.collect({ minimumAgeMs: 0, dryRun: true })).toMatchObject({
            dryRun: true,
            collected: 1,
            artifacts: [{ digest: orphan.digest }],
          })
          expect(yield* artifacts.collect({ minimumAgeMs: 0, dryRun: false })).toMatchObject({
            dryRun: false,
            collected: 1,
            reclaimedBytes: orphan.size,
          })
          expect(yield* artifacts.get(orphan).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
          expect(yield* artifacts.get(retained)).toBe("retained patch")

          yield* artifacts.release({ type: "test", id: "owner" })
          yield* db
            .update(WorkArtifactTable)
            .set({ time_accessed: 0 })
            .where(eq(WorkArtifactTable.digest, retained.digest))
            .run()
            .pipe(Effect.orDie)
          expect(yield* artifacts.collect({ minimumAgeMs: 0, dryRun: false })).toMatchObject({ collected: 1 })
          expect(yield* artifacts.get(retained).pipe(Effect.exit)).toMatchObject({ _tag: "Failure" })
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([Database.node, FSUtil.node, WorkArtifact.node]), [
              [Database.node, Database.layerFromPath(path.join(root.path, "artifact-lifecycle-test.db"))],
              [Global.node, Global.layerWith({ data: root.path })],
            ]),
          ),
        ),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )
})
