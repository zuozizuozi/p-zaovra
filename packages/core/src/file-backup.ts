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
    Schema.Struct({
      id: Schema.String,
      path: RelativePath,
      target: Schema.String,
      before: Version,
      phase: Schema.optional(Schema.Literals(["prepared", "writing", "isolated"])),
    }),
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
  related?: readonly Ticket[]
  after?: Uint8Array | null
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
    related?: readonly { target: { canonical: string }; before: Uint8Array | null; after: Uint8Array | null }[]
  }) => Effect.Effect<Ticket | undefined, FSUtil.Error>
  readonly finish: (ticket: Ticket | undefined, bytes?: Uint8Array | null) => Effect.Effect<void, FSUtil.Error>
  readonly start: (ticket: Ticket | undefined) => Effect.Effect<void, FSUtil.Error>
  /** Only the caller knows whether its filesystem operation was attempted. Never infer after bytes on failure. */
  readonly abandon: (ticket: Ticket | undefined, attempted: boolean) => Effect.Effect<void, FSUtil.Error>
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
    const active = new Set<string>()
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
        blocked: (journal.pending ?? []).map((item) => item.path),
        entries: journal.entries.filter(
          (entry) =>
            entry.seq > Math.min(from.seq, to.seq) &&
            entry.seq <= Math.max(from.seq, to.seq) &&
            !journal.pending?.some((item) => item.path === entry.path),
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
        const changes = [input, ...(input.related ?? [])]
        if (new Set(changes.map((item) => item.target.canonical)).size !== changes.length)
          return yield* failure("duplicate path in file operation")
        if (changes.some((item) => !FSUtil.contains(location.directory, item.target.canonical)))
          return {
            id: randomUUID(),
            key,
            target: input.target.canonical,
            before: { hash: input.before === null ? null : hash(input.before), size: input.before?.length ?? 0 },
            status: { reversible: false, reason: "outside_project" as const },
          }
        return yield* locks.withLock(key)(
          Effect.gen(function* () {
            let journal = yield* load(key)
            if ((journal.pending?.length ?? 0) + changes.length > 64)
              return yield* failure("too many unfinished backups; inspect isolated file changes before writing")
            if (changes.some((change) => journal.pending?.some((item) => item.target === change.target.canonical)))
              return yield* failure(
                "unfinished file change: path is isolated; original bytes retained, refusing another write",
              )
            const tickets: Ticket[] = []
            for (const change of changes) {
              const before = yield* version(key, change.before, journal)
              const ticket: Ticket = {
                id: randomUUID(),
                key,
                target: change.target.canonical,
                path: RelativePath.make(
                  path.relative(location.directory, change.target.canonical).replaceAll("\\", "/"),
                ),
                before: before.value,
                status: {
                  reversible: before.available && !journal.exhausted,
                  ...(!before.available || journal.exhausted ? { reason: "capacity" as const } : {}),
                },
                ...("after" in change ? { after: change.after } : {}),
              }
              tickets.push(ticket)
              journal = {
                ...journal,
                bytes: before.bytes,
                pending: [
                  ...(journal.pending ?? []),
                  {
                    id: ticket.id,
                    target: ticket.target,
                    path: ticket.path!,
                    before: ticket.before,
                    phase: "prepared",
                  },
                ],
              }
            }
            // One journal commit admits both sides of a rename before any filesystem mutation.
            yield* save(key, { ...journal, sessionID: input.sessionID })
            for (const ticket of tickets) active.add(ticket.id)
            return { ...tickets[0], related: tickets.slice(1) }
          }),
        )
      }),
      start: Effect.fn("FileBackup.start")(function* (ticket) {
        if (!ticket?.path) return
        const ids = [ticket, ...(ticket.related ?? [])].map((item) => item.id)
        yield* locks.withLock(ticket.key)(
          Effect.gen(function* () {
            const journal = yield* load(ticket.key)
            if (ids.some((id) => !journal.pending?.some((item) => item.id === id && item.phase === "prepared")))
              return yield* failure("backup ticket is no longer prepared")
            yield* save(ticket.key, {
              ...journal,
              pending: journal.pending?.map((item) =>
                ids.includes(item.id) ? { ...item, phase: "writing" as const } : item,
              ),
            })
          }),
        )
      }),
      abandon: Effect.fn("FileBackup.abandon")(function* (ticket, attempted) {
        if (!ticket?.path) return
        const ids = [ticket, ...(ticket.related ?? [])].map((item) => item.id)
        yield* locks
          .withLock(ticket.key)(
            Effect.gen(function* () {
              const journal = yield* load(ticket.key)
              // A safe rejection cancels only this operation. Uncertain writes retain originals
              // and quarantine their paths; never read current bytes and call them our after.
              yield* save(ticket.key, {
                ...journal,
                pending: attempted
                  ? journal.pending?.map((item) =>
                      ids.includes(item.id) ? { ...item, phase: "isolated" as const } : item,
                    )
                  : journal.pending?.filter((item) => !ids.includes(item.id)),
              })
            }),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                for (const id of ids) active.delete(id)
              }),
            ),
          )
      }),
      finish: Effect.fn("FileBackup.finish")(function* (ticket, bytes) {
        if (!ticket?.path) return
        const tickets = [ticket, ...(ticket.related ?? [])]
        yield* locks.withLock(ticket.key)(
          Effect.gen(function* () {
            let journal = yield* load(ticket.key)
            if (tickets.some((item) => !journal.pending?.some((pending) => pending.id === item.id)))
              return yield* failure("backup ticket missing; refusing to certify write completion")
            const entries: Journal["entries"][number][] = []
            for (const item of tickets) {
              const current = item === ticket ? bytes : item.after
              const after = yield* version(
                ticket.key,
                current === undefined
                  ? yield* fs
                      .readFile(item.target)
                      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)))
                  : current,
                journal,
              )
              journal = { ...journal, bytes: after.bytes }
              item.status = {
                reversible:
                  item.status.reversible && after.available && journal.entries.length + tickets.length <= MAX_ENTRIES,
                ...(!item.status.reversible || !after.available || journal.entries.length + tickets.length > MAX_ENTRIES
                  ? { reason: "capacity" as const }
                  : {}),
              }
              if (after.value.hash !== item.before.hash || after.value.size !== item.before.size)
                entries.push({
                  seq: journal.entries.length + entries.length + 1,
                  path: item.path!,
                  target: item.target,
                  before: item.before,
                  after: after.value,
                  reversible: item.status.reversible,
                })
            }
            const reversible = tickets.every((item) => item.status.reversible)
            for (const item of tickets)
              item.status = reversible ? item.status : { reversible: false, reason: "capacity" }
            // Both rename entries settle in the same commit. A failed commit leaves both pending.
            yield* save(ticket.key, {
              ...journal,
              pending: journal.pending?.filter((item) => !tickets.some((value) => value.id === item.id)),
              exhausted: journal.exhausted || journal.entries.length + tickets.length > MAX_ENTRIES,
              entries:
                journal.entries.length + tickets.length > MAX_ENTRIES
                  ? journal.entries
                  : [...journal.entries, ...entries.map((item) => ({ ...item, reversible }))],
            })
            for (const item of tickets) active.delete(item.id)
          }),
        )
      }),
      capture: Effect.fn("FileBackup.capture")(function* (sessionID) {
        const key = hash(new TextEncoder().encode(sessionID))
        return yield* locks.withLock(key)(
          Effect.gen(function* () {
            const journal = yield* load(key)
            if (journal.pending?.some((item) => active.has(item.id)))
              return yield* failure("file operation still active; capture again after settlement")
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
        if (input.paths?.some((file) => comparison.blocked.includes(file)))
          return yield* failure("unfinished file change: requested path is isolated")
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
