export * as FileMutation from "./file-mutation"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Exit, Layer, Schema, Option } from "effect"
import { dirname } from "path"
import { KeyedMutex } from "./effect/keyed-mutex"
import { FSUtil } from "./fs-util"
import { Formatter } from "./formatter"
import { FileBackup } from "./file-backup"
import { SessionSchema } from "./session/schema"

export interface Target {
  readonly canonical: string
  readonly resource: string
}

export interface WriteInput {
  readonly sessionID?: SessionSchema.ID
  readonly validate?: Effect.Effect<void, TargetChangedError | FSUtil.Error>
  readonly target: Target
  readonly content: string | Uint8Array
  readonly format?: boolean
}

export interface TextWriteInput {
  readonly sessionID?: SessionSchema.ID
  readonly validate?: Effect.Effect<void, TargetChangedError | FSUtil.Error>
  readonly target: Target
  readonly content: string
  readonly format?: boolean
  /** null creates only; text permits replacement only while the observed content still matches. */
  readonly expected?: string | null
}

export interface ConditionalWriteInput extends WriteInput {
  readonly expected: Uint8Array
}

export interface RemoveInput {
  readonly sessionID?: SessionSchema.ID
  readonly target: Target
}

export class TargetChangedError extends Schema.TaggedErrorClass<TargetChangedError>()(
  "FileMutation.TargetChangedError",
  { path: Schema.String },
) {}

export class StaleContentError extends Schema.TaggedErrorClass<StaleContentError>()("FileMutation.StaleContentError", {
  path: Schema.String,
}) {}

export class TargetExistsError extends Schema.TaggedErrorClass<TargetExistsError>()("FileMutation.TargetExistsError", {
  path: Schema.String,
}) {}

export interface WriteResult {
  /** Internal bytes observed at commit, never forwarded by tool output schemas. */
  readonly finalBytes?: Uint8Array
  readonly backup?: FileBackup.Status
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
  readonly formatting?: Formatter.Result
  /** Final content captured under the mutation lock for formatted text writes. */
  readonly content?: string
}

export interface RemoveResult {
  readonly backup?: FileBackup.Status
  readonly operation: "remove"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export interface Interface {
  readonly publish: (input: {
    sessionID?: SessionSchema.ID
    target: Target
    candidate: Target
    backup: Target
    expected: Uint8Array | null
    verified: Uint8Array
    validate: Effect.Effect<void, TargetChangedError | FSUtil.Error>
  }) => Effect.Effect<WriteResult, StaleContentError | TargetChangedError | TargetExistsError | FSUtil.Error>
  /** Create without replacing an existing target. */
  readonly create: (
    input: WriteInput,
  ) => Effect.Effect<WriteResult, TargetExistsError | TargetChangedError | FSUtil.Error>
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, FSUtil.Error>
  /** Write text while retaining an existing UTF-8 BOM and emitting at most one BOM. */
  readonly writeTextPreservingBom: (
    input: TextWriteInput,
  ) => Effect.Effect<WriteResult, TargetExistsError | StaleContentError | TargetChangedError | FSUtil.Error>
  /** Commit only if an existing target still has the expected bytes. */
  readonly writeIfUnchanged: (
    input: ConditionalWriteInput,
  ) => Effect.Effect<WriteResult, StaleContentError | FSUtil.Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<RemoveResult, FSUtil.Error>
  readonly restore: (
    input: FileBackup.Restore & { validate: Effect.Effect<void, TargetChangedError | FSUtil.Error> },
  ) => Effect.Effect<WriteResult | RemoveResult, StaleContentError | TargetChangedError | FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/v2/FileMutation") {}

/**
 * Serialize file changes by canonical target. Conditional writes compare and
 * write under the same process-local lock so cooperating Zaovra mutations do
 * not overwrite changes made from the same stale content.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const formatter = yield* Formatter.Service
    const backups = yield* FileBackup.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const withTargetLock =
      (target: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        locks.withLock(target.canonical)(Effect.uninterruptible(effect))

    const track = <A extends WriteResult | RemoveResult, E, R>(
      input: { target: Target; sessionID?: SessionSchema.ID; verified?: Uint8Array },
      effect: (before: (bytes: Uint8Array | null) => Effect.Effect<void, FSUtil.Error>) => Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        let ticket: FileBackup.Ticket | undefined
        const before = (bytes: Uint8Array | null) =>
          backups.begin({ ...input, before: bytes }).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                ticket = value
              }),
            ),
            Effect.asVoid,
          )
        const result = yield* effect(before).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? backups.finish(
                  ticket,
                  exit.value.operation === "remove" ? null : (exit.value.finalBytes ?? input.verified),
                )
              : Effect.void,
          ),
        )
        return { ...result, ...(ticket ? { backup: ticket.status } : {}) }
      })
    const withMutationLock =
      (input: { target: Target; sessionID?: SessionSchema.ID }) =>
      <A extends WriteResult | RemoveResult, E, R>(
        effect: (before: (bytes: Uint8Array | null) => Effect.Effect<void, FSUtil.Error>) => Effect.Effect<A, E, R>,
      ) =>
        withTargetLock(input.target)(track(input, effect))

    const writeResult = (target: Target, existed: boolean): WriteResult => ({
      operation: "write",
      target: target.canonical,
      resource: target.resource,
      existed,
    })

    const formattedResult = Effect.fn("FileMutation.formattedResult")(function* (input: WriteInput, existed: boolean) {
      if (!input.format)
        return {
          ...writeResult(input.target, existed),
          ...(input.sessionID
            ? {
                finalBytes: typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content,
              }
            : {}),
        }
      const formatting = yield* formatter.format(input.target.canonical)
      const content = yield* fs.readFileString(input.target.canonical)
      return {
        ...writeResult(input.target, existed),
        ...(input.sessionID ? { finalBytes: yield* fs.readFile(input.target.canonical) } : {}),
        content,
        ...(formatting.ran.length || formatting.failed.length ? { formatting } : {}),
      }
    })

    const removeResult = (target: Target, existed: boolean): RemoveResult => ({
      operation: "remove",
      target: target.canonical,
      resource: target.resource,
      existed,
    })

    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withMutationLock(input)((before) =>
        Effect.gen(function* () {
          const existed = yield* fs.exists(input.target.canonical)
          if (input.sessionID) yield* before(existed ? yield* fs.readFile(input.target.canonical) : null)
          yield* fs.writeWithDirs(input.target.canonical, input.content)
          return yield* formattedResult(input, existed)
        }),
      ),
    )

    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")(function* (input: TextWriteInput) {
      if (input.validate) yield* input.validate
      if (input.expected === null) {
        const next = splitBom(input.content)
        return yield* create({ ...input, content: joinBom(next.text, next.bom) })
      }
      return yield* withMutationLock(input)((before) =>
        Effect.gen(function* () {
          if (input.validate) yield* input.validate
          const next = splitBom(input.content)
          const current = yield* fs
            .readFile(input.target.canonical)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
          if (
            typeof input.expected === "string" &&
            (current === undefined ||
              splitBom(new TextDecoder().decode(current)).text !== splitBom(input.expected).text)
          )
            return yield* new StaleContentError({ path: input.target.canonical })
          const bytes = new TextEncoder().encode(
            joinBom(next.text, Boolean(current && hasUtf8Bom(current)) || next.bom),
          )
          if (input.validate && current !== undefined) {
            // Open without truncation, verify the opened object, then use that same
            // descriptor for compare/write. A later symlink swap cannot redirect it.
            yield* Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* fs.open(input.target.canonical, { flag: "r+" })
                const opened = yield* handle.stat
                yield* input.validate!
                const named = yield* fs.stat(input.target.canonical)
                if (
                  opened.type !== "File" ||
                  opened.dev !== named.dev ||
                  Option.getOrNull(opened.ino) !== Option.getOrNull(named.ino)
                )
                  return yield* new TargetChangedError({ path: input.target.canonical })
                const chunks: Uint8Array[] = []
                while (true) {
                  const chunk = yield* handle.readAlloc(65536)
                  if (Option.isNone(chunk)) break
                  chunks.push(chunk.value)
                }
                if (!sameBytes(Buffer.concat(chunks), current))
                  return yield* new StaleContentError({ path: input.target.canonical })
                yield* input.validate!
                yield* before(current)
                yield* input.validate!
                yield* handle.seek(0, "start")
                yield* handle.writeAll(bytes)
                yield* handle.truncate(bytes.length)
                yield* handle.sync
              }),
            )
          } else {
            yield* before(current ?? null)
            if (input.validate) yield* input.validate
            yield* fs.writeWithDirs(input.target.canonical, bytes)
          }
          if (input.validate) yield* input.validate
          return yield* formattedResult({ ...input, content: bytes }, current !== undefined)
        }),
      )
    })

    const create = Effect.fn("FileMutation.create")((input: WriteInput) =>
      withMutationLock(input)((before) =>
        Effect.gen(function* () {
          if (input.validate) yield* input.validate
          if (yield* fs.exists(input.target.canonical))
            return yield* new TargetExistsError({ path: input.target.canonical })
          yield* before(null)
          if (input.validate) yield* input.validate
          const write =
            typeof input.content === "string"
              ? fs.writeFileString(input.target.canonical, input.content, { flag: "wx" })
              : fs.writeFile(input.target.canonical, input.content, { flag: "wx" })
          yield* write.pipe(
            Effect.catchReason("PlatformError", "NotFound", () =>
              fs.ensureDir(dirname(input.target.canonical)).pipe(Effect.andThen(write)),
            ),
            Effect.catchReason("PlatformError", "AlreadyExists", () =>
              Effect.fail(new TargetExistsError({ path: input.target.canonical })),
            ),
          )
          return yield* formattedResult(input, false)
        }),
      ),
    )

    const writeIfUnchanged = Effect.fn("FileMutation.writeIfUnchanged")((input: ConditionalWriteInput) =>
      withMutationLock(input)((before) =>
        Effect.gen(function* () {
          const current = yield* fs.readFile(input.target.canonical)
          if (!sameBytes(current, input.expected)) {
            return yield* new StaleContentError({ path: input.target.canonical })
          }
          yield* before(current)
          const latest = yield* fs.readFile(input.target.canonical)
          if (!sameBytes(latest, current)) return yield* new StaleContentError({ path: input.target.canonical })
          yield* typeof input.content === "string"
            ? fs.writeFileString(input.target.canonical, input.content)
            : fs.writeFile(input.target.canonical, input.content)
          return yield* formattedResult(input, true)
        }),
      ),
    )

    const remove = Effect.fn("FileMutation.remove")((input: RemoveInput) =>
      withMutationLock(input)((before) =>
        Effect.gen(function* () {
          if (input.sessionID)
            yield* before(
              yield* fs
                .readFile(input.target.canonical)
                .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null))),
            )
          const existed = yield* fs.remove(input.target.canonical).pipe(
            Effect.as(true),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
          )
          return removeResult(input.target, existed)
        }),
      ),
    )

    const publish: Interface["publish"] = (input) => {
      const commit = (before: (bytes: Uint8Array | null) => Effect.Effect<void, FSUtil.Error>) =>
        Effect.gen(function* () {
          yield* input.validate
          if (new Set([input.target.canonical, input.candidate.canonical, input.backup.canonical]).size !== 3)
            return yield* new TargetChangedError({ path: input.target.canonical })
          const candidate = yield* fs.readFile(input.candidate.canonical)
          const current = yield* fs
            .readFile(input.target.canonical)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)))
          if (
            !sameBytes(candidate, input.verified) ||
            (current === null
              ? input.expected !== null
              : input.expected === null || !sameBytes(current, input.expected))
          )
            return yield* new StaleContentError({ path: input.target.canonical })
          if (current !== null) {
            // Immutable content-addressed backup is written before the single rename.
            // A failed backup or interrupted preflight leaves the final path intact.
            yield* fs
              .writeFile(input.backup.canonical, current, { flag: "wx" })
              .pipe(
                Effect.catchReason("PlatformError", "AlreadyExists", () =>
                  fs
                    .readFile(input.backup.canonical)
                    .pipe(
                      Effect.flatMap((bytes) =>
                        sameBytes(bytes, current)
                          ? Effect.void
                          : Effect.fail(new TargetExistsError({ path: input.backup.canonical })),
                      ),
                    ),
                ),
              )
          }
          yield* input.validate
          const unchanged = yield* fs.readFile(input.candidate.canonical)
          const latest = yield* fs
            .readFile(input.target.canonical)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)))
          if (
            !sameBytes(unchanged, candidate) ||
            (current === null ? latest !== null : latest === null || !sameBytes(latest, current))
          )
            return yield* new StaleContentError({ path: input.target.canonical })
          yield* before(current)
          yield* input.validate
          const ready = yield* fs
            .readFile(input.target.canonical)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)))
          if (current === null ? ready !== null : ready === null || !sameBytes(ready, current))
            return yield* new StaleContentError({ path: input.target.canonical })
          yield* fs.rename(input.candidate.canonical, input.target.canonical)
          return writeResult(input.target, current !== null)
        })
      return [input.target, input.candidate, input.backup]
        .sort((a, b) => a.canonical.localeCompare(b.canonical))
        .reduceRight((effect, target) => withTargetLock(target)(effect), track(input, commit))
    }

    const restore: Interface["restore"] = (input) => {
      const target = { canonical: input.target, resource: input.path }
      return withMutationLock({ target, sessionID: input.sessionID })((before) =>
        Effect.gen(function* () {
          yield* input.validate
          const current = yield* fs
            .readFile(input.target)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)))
          if ((current === null ? null : FileBackup.hash(current)) !== input.expected)
            return yield* new StaleContentError({ path: input.target })
          yield* input.validate
          yield* before(current)
          yield* input.validate
          if (input.content === null) {
            const ready = yield* fs
              .readFile(input.target)
              .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)))
            if ((ready === null ? null : FileBackup.hash(ready)) !== input.expected)
              return yield* new StaleContentError({ path: input.target })
            if (current !== null) yield* fs.remove(input.target)
            return removeResult(target, current !== null)
          }
          if (current === null) {
            yield* fs.ensureDir(dirname(input.target))
            yield* fs.writeFile(input.target, input.content, { flag: "wx" })
          } else {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* fs.open(input.target, { flag: "r+" })
                const opened = yield* handle.stat
                yield* input.validate
                const named = yield* fs.stat(input.target)
                if (opened.dev !== named.dev || Option.getOrNull(opened.ino) !== Option.getOrNull(named.ino))
                  return yield* new TargetChangedError({ path: input.target })
                const chunks: Uint8Array[] = []
                while (true) {
                  const chunk = yield* handle.readAlloc(65536)
                  if (Option.isNone(chunk)) break
                  chunks.push(chunk.value)
                }
                if (FileBackup.hash(Buffer.concat(chunks)) !== input.expected)
                  return yield* new StaleContentError({ path: input.target })
                yield* handle.seek(0, "start")
                yield* handle.writeAll(input.content!)
                yield* handle.truncate(input.content!.length)
                yield* handle.sync
              }),
            )
          }
          return { ...writeResult(target, current !== null), finalBytes: input.content }
        }),
      )
    }

    return Service.of({ create, write, writeTextPreservingBom, writeIfUnchanged, remove, publish, restore })
  }),
)

function splitBom(text: string) {
  const stripped = text.replace(/^\uFEFF+/, "")
  return { bom: stripped.length !== text.length, text: stripped }
}

function joinBom(text: string, bom: boolean) {
  const stripped = splitBom(text).text
  return bom ? `\uFEFF${stripped}` : stripped
}

function hasUtf8Bom(content: Uint8Array) {
  return content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false
  return left.every((byte, index) => byte === right[index])
}

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Formatter.node, FileBackup.node] })

/**
 * Deferred until the corresponding V2 integrations exist.
 */
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after V2 snapshot design exists.
// TODO: Notify LSP and collect diagnostics after V2 LSP runtime exists.
// TODO: Design multi-file transactions / rollback if apply_patch needs atomic edits.
// Until then, edits are sequential and report partial application.
// TODO: Define crash recovery and idempotency for side effects between Tool.Called and durable settlement.
