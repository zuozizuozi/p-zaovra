export * as WorkArtifact from "./artifact"

import { Work } from "@zaovra-ai/schema/work"
import { and, asc, eq, isNull, lte } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import path from "path"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Hash } from "../util/hash"
import { WorkArtifactOwnerTable, WorkArtifactTable } from "./sql"

const prefix = "zaovra-work-artifact://sha256/"
export const minimumCollectionAgeMs = 60_000

export class InvalidReferenceError extends Schema.TaggedErrorClass<InvalidReferenceError>()(
  "WorkArtifact.InvalidReference",
  { reference: Schema.String },
) {}

export class MissingError extends Schema.TaggedErrorClass<MissingError>()("WorkArtifact.Missing", {
  reference: Schema.String,
}) {}

export class CorruptError extends Schema.TaggedErrorClass<CorruptError>()("WorkArtifact.Corrupt", {
  reference: Schema.String,
  expectedDigest: Schema.String,
  actualDigest: Schema.String,
}) {}

export type Error = InvalidReferenceError | MissingError | CorruptError | FSUtil.Error

export interface Interface {
  readonly put: (content: string) => Effect.Effect<Work.ArtifactReference, Error>
  readonly get: (artifact: Work.ArtifactReference) => Effect.Effect<string, Error>
  readonly retain: (
    artifact: Work.ArtifactReference,
    owner: { readonly type: string; readonly id: string },
  ) => Effect.Effect<void, Error>
  readonly release: (owner: { readonly type: string; readonly id: string }) => Effect.Effect<void>
  readonly inventory: Effect.Effect<ReadonlyArray<Work.ArtifactLifecycleInfo>>
  readonly collect: (options: {
    readonly minimumAgeMs: number
    readonly dryRun: boolean
    readonly limit?: number
  }) => Effect.Effect<Work.ArtifactCollectionReport, Error>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/WorkArtifact") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const db = (yield* Database.Service).db
    const root = path.join(global.data, "work", "artifacts")

    const get = Effect.fn("WorkArtifact.get")(function* (artifact: Work.ArtifactReference) {
      const digest = parse(artifact.reference)
      if (!digest || digest !== artifact.digest)
        return yield* new InvalidReferenceError({ reference: artifact.reference })
      const content = yield* fs.readFileStringSafe(file(root, digest))
      if (content === undefined) return yield* new MissingError({ reference: artifact.reference })
      const actualDigest = hash(content)
      if (actualDigest !== artifact.digest || size(content) !== artifact.size)
        return yield* new CorruptError({
          reference: artifact.reference,
          expectedDigest: artifact.digest,
          actualDigest,
        })
      yield* db
        .update(WorkArtifactTable)
        .set({ time_accessed: Date.now() })
        .where(and(eq(WorkArtifactTable.digest, artifact.digest), isNull(WorkArtifactTable.time_collected)))
        .run()
        .pipe(Effect.orDie)
      return content
    })

    const put = Effect.fn("WorkArtifact.put")(function* (content: string) {
      const digest = hash(content)
      const artifact = Work.ArtifactReference.make({
        digest,
        reference: `${prefix}${digest}`,
        size: size(content),
        mediaType: "text/x-diff",
      })
      const now = Date.now()
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const existing = yield* fs.readFileStringSafe(file(root, digest))
              if (existing === undefined || hash(existing) !== digest || size(existing) !== artifact.size)
                yield* fs.writeWithDirs(file(root, digest), content)
              yield* tx
                .insert(WorkArtifactTable)
                .values({
                  digest,
                  reference: artifact.reference,
                  size: artifact.size,
                  media_type: artifact.mediaType,
                  time_created: now,
                  time_accessed: now,
                })
                .onConflictDoUpdate({
                  target: WorkArtifactTable.digest,
                  set: {
                    reference: artifact.reference,
                    size: artifact.size,
                    media_type: artifact.mediaType,
                    time_accessed: now,
                    time_collected: null,
                  },
                })
                .run()
                .pipe(Effect.orDie)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      yield* get(artifact)
      return artifact
    })

    const retain = Effect.fn("WorkArtifact.retain")(function* (
      artifact: Work.ArtifactReference,
      owner: { readonly type: string; readonly id: string },
    ) {
      if (!owner.type.trim() || !owner.id.trim() || owner.type.length > 100 || owner.id.length > 500)
        return yield* new InvalidReferenceError({ reference: artifact.reference })
      yield* get(artifact)
      const retained = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* tx
                .select({ digest: WorkArtifactTable.digest })
                .from(WorkArtifactTable)
                .where(and(eq(WorkArtifactTable.digest, artifact.digest), isNull(WorkArtifactTable.time_collected)))
                .get()
                .pipe(Effect.orDie)
              if (!current) return false
              yield* tx
                .insert(WorkArtifactOwnerTable)
                .values({
                  digest: artifact.digest,
                  owner_type: owner.type.trim(),
                  owner_id: owner.id.trim(),
                  time_created: Date.now(),
                })
                .onConflictDoNothing()
                .run()
                .pipe(Effect.orDie)
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (!retained) return yield* new MissingError({ reference: artifact.reference })
      return undefined
    })

    const inventory = Effect.gen(function* () {
      const rows = yield* db
        .select()
        .from(WorkArtifactTable)
        .orderBy(asc(WorkArtifactTable.time_created))
        .all()
        .pipe(Effect.orDie)
      return yield* Effect.forEach(rows, (row) =>
        db
          .select({ ownerID: WorkArtifactOwnerTable.owner_id })
          .from(WorkArtifactOwnerTable)
          .where(eq(WorkArtifactOwnerTable.digest, row.digest))
          .all()
          .pipe(
            Effect.orDie,
            Effect.map((owners) => lifecycle(row, owners.length)),
          ),
      )
    })

    const collect = Effect.fn("WorkArtifact.collect")(function* (options: {
      readonly minimumAgeMs: number
      readonly dryRun: boolean
      readonly limit?: number
    }) {
      const now = Date.now()
      const rows = yield* db
        .select()
        .from(WorkArtifactTable)
        .where(
          and(
            isNull(WorkArtifactTable.time_collected),
            lte(WorkArtifactTable.time_accessed, now - Math.max(minimumCollectionAgeMs, options.minimumAgeMs)),
          ),
        )
        .orderBy(asc(WorkArtifactTable.time_accessed))
        .limit(Math.min(Math.max(options.limit ?? 100, 1), 1_000))
        .all()
        .pipe(Effect.orDie)
      const candidates = [] as Work.ArtifactReference[]
      for (const row of rows) {
        const owners = yield* db
          .select({ ownerID: WorkArtifactOwnerTable.owner_id })
          .from(WorkArtifactOwnerTable)
          .where(eq(WorkArtifactOwnerTable.digest, row.digest))
          .all()
          .pipe(Effect.orDie)
        if (owners.length > 0) continue
        const artifact = reference(row)
        if (options.dryRun) {
          candidates.push(artifact)
          continue
        }
        const collected = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const currentOwners = yield* tx
                  .select({ ownerID: WorkArtifactOwnerTable.owner_id })
                  .from(WorkArtifactOwnerTable)
                  .where(eq(WorkArtifactOwnerTable.digest, row.digest))
                  .all()
                  .pipe(Effect.orDie)
                if (currentOwners.length > 0) return false
                yield* fs.remove(file(root, row.digest), { force: true })
                const updated = yield* tx
                  .update(WorkArtifactTable)
                  .set({ time_collected: now, time_accessed: now })
                  .where(and(eq(WorkArtifactTable.digest, row.digest), isNull(WorkArtifactTable.time_collected)))
                  .returning({ digest: WorkArtifactTable.digest })
                  .get()
                  .pipe(Effect.orDie)
                return updated !== undefined
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        if (collected) candidates.push(artifact)
      }
      return Work.ArtifactCollectionReport.make({
        dryRun: options.dryRun,
        scanned: rows.length,
        collected: candidates.length,
        reclaimedBytes: candidates.reduce((total, artifact) => total + artifact.size, 0),
        artifacts: candidates,
      })
    })

    return Service.of({
      put,
      get,
      retain,
      release: Effect.fn("WorkArtifact.release")(function* (owner) {
        yield* db
          .delete(WorkArtifactOwnerTable)
          .where(
            and(
              eq(WorkArtifactOwnerTable.owner_type, owner.type.trim()),
              eq(WorkArtifactOwnerTable.owner_id, owner.id.trim()),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }),
      inventory,
      collect,
    })
  }),
)

function lifecycle(row: typeof WorkArtifactTable.$inferSelect, referenceCount: number) {
  return Work.ArtifactLifecycleInfo.make({
    artifact: reference(row),
    referenceCount,
    state: row.time_collected === null ? "active" : "collected",
    createdAt: DateTime.makeUnsafe(row.time_created),
    accessedAt: DateTime.makeUnsafe(row.time_accessed),
    collectedAt: row.time_collected === null ? undefined : DateTime.makeUnsafe(row.time_collected),
  })
}

function reference(row: typeof WorkArtifactTable.$inferSelect) {
  return Work.ArtifactReference.make({
    digest: row.digest,
    reference: row.reference,
    size: row.size,
    mediaType: row.media_type,
  })
}

function parse(reference: string) {
  const digest = reference.startsWith(prefix) ? reference.slice(prefix.length) : undefined
  return digest && /^[a-f0-9]{64}$/.test(digest) ? digest : undefined
}

function file(root: string, digest: string) {
  return path.join(root, digest.slice(0, 2), `${digest}.patch`)
}

function hash(value: string) {
  return Hash.sha256(value)
}

function size(value: string) {
  return new TextEncoder().encode(value).byteLength
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, FSUtil.node, Global.node] })
