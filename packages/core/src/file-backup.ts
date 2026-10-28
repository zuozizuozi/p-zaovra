export * as FileBackup from "./file-backup"

import { createHash, randomUUID } from "crypto"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { createTwoFilesPatch, diffLines } from "diff"
import { makeLocationNode } from "./effect/app-node"
import { KeyedMutex } from "./effect/keyed-mutex"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"
import { Config } from "./config"
import { RelativePath } from "./schema"
import { SessionSchema } from "./session/schema"

export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_SESSION_BYTES = 100 * 1024 * 1024
export const MAX_ENTRIES = 1000
export const Status = Schema.Struct({
  reversible: Schema.Boolean,
  reason: Schema.optional(Schema.Literals(["capacity", "outside_project"])),
})
export type Status = typeof Status.Type

const Version = Schema.Struct({ hash: Schema.NullOr(Schema.String), size: Schema.Number })
type Version = typeof Version.Type
const Entry = Schema.Struct({
  seq: Schema.Number,
  path: RelativePath,
  target: Schema.String,
  before: Version,
  after: Version,
  reversible: Schema.Boolean,
})
const Journal = Schema.Struct({
  sessionID: Schema.optional(SessionSchema.ID),
  bytes: Schema.Number,
  entries: Schema.Array(Entry),
  exhausted: Schema.Boolean,
  pending: Schema.Array(
    Schema.Struct({ id: Schema.String, path: RelativePath, target: Schema.String, before: Version }),
  ).pipe(Schema.optional),
})
type Journal = typeof Journal.Type

const changedPaths = (entries: Journal["entries"]) =>
  [...new Set(entries.map((entry) => entry.path))].filter((file) => {
    const versions = entries.filter((entry) => entry.path === file)
    return versions[0].before.hash !== versions.at(-1)!.after.hash
  })

export interface Ticket {
  id: string
  key: string
  path?: RelativePath
  target: string
  before: Version
  status: Status
}
export interface Restore {
  sessionID: SessionSchema.ID
  target: string
  path: RelativePath
  expected: string | null
  content: Uint8Array | null
}
export interface Interface {
  readonly begin: (input: {
    sessionID?: SessionSchema.ID
    target: { canonical: string }
    before: Uint8Array | null
  }) => Effect.Effect<Ticket | undefined, FSUtil.Error>
  readonly finish: (ticket: Ticket | undefined, bytes?: Uint8Array | null) => Effect.Effect<void, FSUtil.Error>
  readonly capture: (sessionID: SessionSchema.ID) => Effect.Effect<string, FSUtil.Error>
  readonly diff: (input: {
    from: string
    to: string
    paths?: readonly RelativePath[]
    context?: number
  }) => Effect.Effect<
    ReadonlyArray<{
      path: RelativePath
      status: "added" | "modified" | "deleted"
      patch: string
      additions: number
      deletions: number
    }>,
    FSUtil.Error
  >
  readonly files: (input: { from: string; to: string }) => Effect.Effect<readonly RelativePath[], FSUtil.Error>
  readonly restore: (files: ReadonlyMap<RelativePath, string>) => Effect.Effect<readonly Restore[], FSUtil.Error>
}
export class Service extends Context.Service<Service, Interface>()("@zaovra/FileBackup") {}

export const isID = (id: string) => /^nongit:[a-f0-9]{64}:\d+$/.test(id)
export const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export const directory = (data: string, sessionID: SessionSchema.ID) =>
  path.join(data, "session-file-backup", hash(new TextEncoder().encode(sessionID)))
export const describe = (status: Status | undefined) =>
  status?.reversible !== false
    ? ""
    : status.reason === "outside_project"
      ? "Outside the active folder: this change is untracked and cannot be undone."
      : "Backup capacity exceeded: this change cannot be undone."

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const config = yield* Config.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const usage = new Map<string, number>()
    const placement = hash(new TextEncoder().encode(location.directory))
    const home = (key: string) => path.join(global.data, "session-file-backup", key, placement)
    const failure = (message: string) => new FSUtil.FileSystemError({ method: `FileBackup: ${message}` })
    const load = Effect.fnUntraced(function* (key: string) {
      const journal = !(yield* fs.exists(path.join(home(key), "journal.json")))
        ? ({ bytes: 0, entries: [], exhausted: false } satisfies Journal)
        : yield* fs.readJson(path.join(home(key), "journal.json")).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Journal)),
            Effect.mapError((cause) => new FSUtil.FileSystemError({ method: "FileBackup.load", cause })),
          )
      if (!usage.has(key)) {
        const blobs = yield* fs
          .readDirectory(home(key))
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])))
        const sizes = yield* Effect.forEach(
          blobs.filter((file) => /^[a-f0-9]{64}$/.test(file)),
          (file) => fs.stat(path.join(home(key), file)).pipe(Effect.map((stat) => Number(stat.size))),
        )
        usage.set(
          key,
          Math.max(
            journal.bytes,
            sizes.reduce((sum, size) => sum + size, 0),
          ),
        )
      }
      return { ...journal, bytes: Math.max(journal.bytes, usage.get(key) ?? 0) }
    })
    const persist = Effect.fnUntraced(function* (key: string, name: string, bytes: string | Uint8Array) {
      yield* fs.makeDirectory(home(key), { recursive: true, mode: 0o700 })
      const temp = path.join(home(key), `pending-${randomUUID()}.tmp`)
      yield* Effect.gen(function* () {
        yield* fs.writeWithDirs(temp, bytes, 0o600)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(temp, { flag: "r+" })
            yield* file.sync
          }),
        )
        yield* fs.rename(temp, path.join(home(key), name))
      }).pipe(Effect.ensuring(fs.remove(temp, { force: true }).pipe(Effect.ignore)))
    })
    const save = (key: string, journal: Journal) => persist(key, "journal.json", JSON.stringify(journal))
    const version = Effect.fnUntraced(function* (key: string, content: Uint8Array | null, journal: Journal) {
      if (content === null) return { value: { hash: null, size: 0 }, bytes: journal.bytes, available: true }
      const digest = hash(content)
      if (content.length > MAX_FILE_BYTES)
        return { value: { hash: digest, size: content.length }, bytes: journal.bytes, available: false }
      const blob = path.join(home(key), digest)
      if (yield* fs.exists(blob)) {
        if (hash(yield* fs.readFile(blob)) !== digest)
          return yield* failure("existing backup hash mismatch; original file was not changed")
        return { value: { hash: digest, size: content.length }, bytes: journal.bytes, available: true }
      }
      if (journal.bytes + content.length > MAX_SESSION_BYTES)
        return { value: { hash: digest, size: content.length }, bytes: journal.bytes, available: false }
      usage.set(key, journal.bytes + content.length)
      yield* persist(key, digest, content)
      return { value: { hash: digest, size: content.length }, bytes: journal.bytes + content.length, available: true }
    })
    const decode = (id: string) => {
      if (!isID(id)) throw new Error("Invalid non-git backup ID")
      const parts = id.split(":")
      return { key: parts[1], seq: Number(parts[2]) }
    }
    const compare = Effect.fnUntraced(function* (input: { from: string; to: string }) {
      const from = decode(input.from)
      const to = decode(input.to)
      if (from.key !== to.key) return yield* failure("different Sessions cannot be compared")
      const journal = yield* load(from.key)
      return {
        key: from.key,
        entries: journal.entries.filter(
          (entry) => entry.seq > Math.min(from.seq, to.seq) && entry.seq <= Math.max(from.seq, to.seq),
        ),
        reverse: from.seq > to.seq,
      }
    })
    const content = Effect.fnUntraced(function* (key: string, version: Version) {
      if (version.hash === null) return null
      if (!/^[a-f0-9]{64}$/.test(version.hash))
        return yield* failure("backup capacity exceeded; this change cannot be undone")
      const bytes = yield* fs.readFile(path.join(home(key), version.hash))
      if (hash(bytes) !== version.hash) return yield* failure("backup content hash mismatch")
      return bytes
    })

    return Service.of({
      begin: Effect.fn("FileBackup.begin")(function* (input) {
        if (!input.sessionID || location.vcs?.type === "git") return
        if (Config.latest(yield* config.entries(), "snapshots") === false) return
        const key = hash(new TextEncoder().encode(input.sessionID))
        if (!FSUtil.contains(location.directory, input.target.canonical))
          return {
            id: randomUUID(),
            key,
            target: input.target.canonical,
            before: { hash: input.before === null ? null : hash(input.before), size: input.before?.length ?? 0 },
            status: { reversible: false, reason: "outside_project" as const },
          }
        return yield* locks.withLock(key)(
          Effect.gen(function* () {
            const journal = yield* load(key)
            if ((journal.pending?.length ?? 0) >= 64)
              return yield* failure("too many unfinished backups; inspect interrupted file changes before writing")
            yield* fs.makeDirectory(home(key), { recursive: true, mode: 0o700 })
            const before = yield* version(key, input.before, journal)
            const pending = {
              id: randomUUID(),
              target: input.target.canonical,
              path: RelativePath.make(path.relative(location.directory, input.target.canonical).replaceAll("\\", "/")),
              before: before.value,
            }
            yield* save(key, {
              ...journal,
              sessionID: input.sessionID,
              bytes: before.bytes,
              pending: [...(journal.pending ?? []), pending],
            })
            return {
              ...pending,
              key,
              status: {
                reversible: before.available && !journal.exhausted,
                ...(!before.available || journal.exhausted ? { reason: "capacity" as const } : {}),
              },
            }
          }),
        )
      }),
      finish: Effect.fn("FileBackup.finish")(function* (ticket, bytes) {
        if (!ticket?.path) return
        const file = ticket.path
        yield* locks.withLock(ticket.key)(
          Effect.gen(function* () {
            const journal = yield* load(ticket.key)
            const current =
              bytes === undefined
                ? yield* fs
                    .readFile(ticket.target)
                    .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)))
                : bytes
            const after = yield* version(ticket.key, current, journal)
            if (after.value.hash === ticket.before.hash && after.value.size === ticket.before.size) {
              yield* save(ticket.key, {
                ...journal,
                pending: (journal.pending ?? []).filter((item) => item.id !== ticket.id),
              })
              return
            }
            ticket.status = {
              reversible: ticket.status.reversible && after.available && journal.entries.length < MAX_ENTRIES,
              ...(!ticket.status.reversible || !after.available || journal.entries.length >= MAX_ENTRIES
                ? { reason: "capacity" as const }
                : {}),
            }
            yield* save(ticket.key, {
              ...journal,
              pending: (journal.pending ?? []).filter((item) => item.id !== ticket.id),
              bytes: after.bytes,
              exhausted: journal.exhausted || journal.entries.length >= MAX_ENTRIES,
              entries:
                journal.entries.length >= MAX_ENTRIES
                  ? journal.entries
                  : [
                      ...journal.entries,
                      {
                        seq: journal.entries.length + 1,
                        path: file,
                        target: ticket.target,
                        before: ticket.before,
                        after: after.value,
                        reversible: ticket.status.reversible,
                      },
                    ],
            })
          }),
        )
      }),
      capture: Effect.fn("FileBackup.capture")(function* (sessionID) {
        const key = hash(new TextEncoder().encode(sessionID))
        return yield* locks.withLock(key)(
          Effect.gen(function* () {
            const journal = yield* load(key)
            if (journal.pending?.length)
              return yield* failure("unfinished backup: write completion cannot be verified; changes remain untracked")
            yield* save(key, { ...journal, sessionID })
            return `nongit:${key}:${journal.entries.length}`
          }),
        )
      }),
      files: Effect.fn("FileBackup.files")(function* (input) {
        return changedPaths((yield* compare(input)).entries)
      }),
      diff: Effect.fn("FileBackup.diff")(function* (input) {
        const comparison = yield* compare(input)
        const paths = changedPaths(comparison.entries).filter((file) => !input.paths || input.paths.includes(file))
        return yield* Effect.forEach(
          paths,
          Effect.fnUntraced(function* (file) {
            const entries = comparison.entries.filter((entry) => entry.path === file)
            if (entries.some((entry) => !entry.reversible))
              return yield* failure("backup capacity exceeded; diff and undo are unavailable for this change")
            const left = yield* content(comparison.key, comparison.reverse ? entries.at(-1)!.after : entries[0].before)
            const right = yield* content(comparison.key, comparison.reverse ? entries[0].before : entries.at(-1)!.after)
            const before = left ? new TextDecoder().decode(left) : ""
            const after = right ? new TextDecoder().decode(right) : ""
            return {
              path: file,
              status:
                left === null ? ("added" as const) : right === null ? ("deleted" as const) : ("modified" as const),
              patch: createTwoFilesPatch(file, file, before, after, undefined, undefined, { context: input.context }),
              ...diffLines(before, after).reduce(
                (counts, line) => ({
                  additions: counts.additions + (line.added ? (line.count ?? 0) : 0),
                  deletions: counts.deletions + (line.removed ? (line.count ?? 0) : 0),
                }),
                { additions: 0, deletions: 0 },
              ),
            }
          }),
        )
      }),
      restore: Effect.fn("FileBackup.restore")(function* (files) {
        return yield* Effect.forEach(
          [...files],
          Effect.fnUntraced(function* ([file, id]) {
            const point = decode(id)
            const journal = yield* load(point.key)
            if (journal.pending?.some((item) => item.path === file))
              return yield* failure(`Unfinished file change: ${file}; refusing to overwrite`)
            if (journal.exhausted || journal.entries.length + files.size * 2 > MAX_ENTRIES)
              return yield* failure("backup capacity exceeded; cannot retain undo and redo, so no file was changed")
            const entries = journal.entries.filter((entry) => entry.path === file)
            const next = entries.find((entry) => entry.seq > point.seq)
            const latest = entries.at(-1)
            if (!latest || !journal.sessionID || entries.some((entry) => !entry.reversible))
              return yield* failure(`Not reversible: ${file}`)
            const selected = next ? next.before : latest.after
            const desired = yield* content(point.key, selected)
            return {
              sessionID: journal.sessionID,
              target: latest.target,
              path: file,
              expected: latest.after.hash,
              content: desired,
            }
          }),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Config.node],
})
