export * as FileMutation from "./file-mutation"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Schema, Option } from "effect"
import { dirname } from "path"
import { KeyedMutex } from "./effect/keyed-mutex"
import { FSUtil } from "./fs-util"
import { Formatter } from "./formatter"

export interface Target {
  readonly canonical: string
  readonly resource: string
}

export interface WriteInput {
  readonly validate?: Effect.Effect<void, TargetChangedError | FSUtil.Error>
  readonly target: Target
  readonly content: string | Uint8Array
  readonly format?: boolean
}

export interface TextWriteInput {
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
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
  readonly formatting?: Formatter.Result
  /** Final content captured under the mutation lock for formatted text writes. */
  readonly content?: string
}

export interface RemoveResult {
  readonly operation: "remove"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export interface Interface {
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
    const locks = KeyedMutex.makeUnsafe<string>()
    const withTargetLock =
      (target: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        locks.withLock(target.canonical)(Effect.uninterruptible(effect))

    const writeResult = (target: Target, existed: boolean): WriteResult => ({
      operation: "write",
      target: target.canonical,
      resource: target.resource,
      existed,
    })

    const formattedResult = Effect.fn("FileMutation.formattedResult")(function* (input: WriteInput, existed: boolean) {
      if (!input.format) return writeResult(input.target, existed)
      const formatting = yield* formatter.format(input.target.canonical)
      const content = yield* fs.readFileString(input.target.canonical)
      return {
        ...writeResult(input.target, existed),
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
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const existed = yield* fs.exists(input.target.canonical)
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
      return yield* withTargetLock(input.target)(
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
                yield* handle.seek(0, "start")
                yield* handle.writeAll(bytes)
                yield* handle.truncate(bytes.length)
                yield* handle.sync
              }),
            )
          } else {
            yield* fs.writeWithDirs(input.target.canonical, bytes)
          }
          if (input.validate) yield* input.validate
          return yield* formattedResult(input, current !== undefined)
        }),
      )
    })

    const create = Effect.fn("FileMutation.create")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
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
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const current = yield* fs.readFile(input.target.canonical)
          if (!sameBytes(current, input.expected)) {
            return yield* new StaleContentError({ path: input.target.canonical })
          }
          yield* typeof input.content === "string"
            ? fs.writeFileString(input.target.canonical, input.content)
            : fs.writeFile(input.target.canonical, input.content)
          return yield* formattedResult(input, true)
        }),
      ),
    )

    const remove = Effect.fn("FileMutation.remove")((input: RemoveInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const existed = yield* fs.remove(input.target.canonical).pipe(
            Effect.as(true),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
          )
          return removeResult(input.target, existed)
        }),
      ),
    )

    return Service.of({ create, write, writeTextPreservingBom, writeIfUnchanged, remove })
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

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Formatter.node] })

/**
 * Deferred until the corresponding V2 integrations exist.
 */
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after V2 snapshot design exists.
// TODO: Notify LSP and collect diagnostics after V2 LSP runtime exists.
// TODO: Design multi-file transactions / rollback if apply_patch needs atomic edits.
// Until then, edits are sequential and report partial application.
// TODO: Define crash recovery and idempotency for side effects between Tool.Called and durable settlement.
