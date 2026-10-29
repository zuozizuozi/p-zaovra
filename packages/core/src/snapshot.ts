export * as Snapshot from "./snapshot"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "./config"
import { File } from "./file"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath, RelativePath } from "./schema"
import { Hash } from "./util/hash"
import { FileBackup } from "./file-backup"
import { FileMutation } from "./file-mutation"
import { LocationMutation } from "./location-mutation"
import { SessionSchema } from "./session/schema"

export const ID = Schema.String.pipe(Schema.brand("Snapshot.ID"))
export type ID = typeof ID.Type

export class Error extends Schema.TaggedErrorClass<Error>()("Snapshot.Error", {
  operation: Schema.Literals(["capture", "files", "diff", "preview", "restore"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface CompareInput {
  readonly from: ID
  readonly to: ID
}

export interface DiffInput extends CompareInput {
  readonly context?: number
  readonly paths?: readonly RelativePath[]
}

export interface RestoreInput {
  /** Paths are relative to the project root. */
  readonly files: ReadonlyMap<RelativePath, ID>
}

export interface PreviewInput extends RestoreInput {
  readonly context?: number
}

export interface Interface {
  /**
   * Capture the current Location-scoped filesystem state as a content-addressed
   * tree. Returns `undefined` when snapshots are disabled, unsupported, or the
   * best-effort capture fails.
   */
  // Session opt-in tracks tool writes in non-git folders, not arbitrary shell changes.
  readonly capture: (input?: { sessionID: SessionSchema.ID }) => Effect.Effect<ID | undefined>

  /**
   * List project-relative paths changed between two captured trees without
   * loading file contents or generating patches.
   */
  readonly files: (input: CompareInput) => Effect.Effect<readonly RelativePath[], Error>

  /**
   * Generate structured per-file diffs between two captured trees. `context`
   * controls unchanged lines around each unified diff hunk.
   */
  readonly diff: (input: DiffInput) => Effect.Effect<readonly File.Diff[], Error>

  /**
   * Preview the filesystem result of a selective restore without modifying the
   * worktree. Each project-relative path maps to the tree it would be restored
   * from.
   */
  readonly preview: (input: PreviewInput) => Effect.Effect<readonly File.Diff[], Error>

  /**
   * Restore selected project-relative paths from their associated trees. A path
   * absent from its selected tree is removed; paths outside the map are untouched.
   */
  readonly restore: (input: RestoreInput) => Effect.Effect<void, Error>

  /**
   * Replace the snapshot index with a captured tree and check out all its entries.
   * Files absent from the tree remain untouched. Prefer selective `restore` when
   * only known paths should change.
   */
  readonly checkout: (snapshot: ID) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/v2/Snapshot") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const backups = yield* FileBackup.Service
    const mutations = yield* FileMutation.Service
    const targets = yield* LocationMutation.Service
    const source = yield* git.repo.discover(location.project.directory)
    const worktree = source
      ? AbsolutePath.make(yield* fs.realPath(source.worktree).pipe(Effect.orDie))
      : location.project.directory
    const gitDirectory = AbsolutePath.make(path.join(global.data, "snapshot", location.project.id, Hash.fast(worktree)))

    const scope = Effect.fnUntraced(function* () {
      const relative = path.relative(worktree, location.directory)
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* new Error({ operation: "capture", message: "Location is outside the project" })
      return RelativePath.make(relative.replaceAll("\\", "/") || ".")
    })

    const repository = Effect.fnUntraced(function* () {
      if (!source) return yield* new Error({ operation: "capture", message: "Project is not a Git repository" })
      return yield* git.repo
        .create({
          worktree,
          gitDirectory,
          seed: source,
        })
        .pipe(Effect.mapError((cause) => failure("capture", cause)))
    })

    const enabled = Effect.fnUntraced(function* () {
      if (location.vcs?.type !== "git") return false
      return Config.latest(yield* config.entries(), "snapshots") !== false
    })

    const capture = Effect.fn("Snapshot.capture")(function* (input?: { sessionID: SessionSchema.ID }) {
      if (!source && input && Config.latest(yield* config.entries(), "snapshots") !== false)
        return yield* backups.capture(input.sessionID).pipe(
          Effect.map(ID.make),
          Effect.orElseSucceed(() => undefined),
        )
      if (!(yield* enabled())) return undefined
      return yield* Effect.gen(function* () {
        const repo = yield* repository()
        return ID.make(
          yield* git.tree.capture({
            repository: repo,
            scopes: [yield* scope()],
            ignores: source,
            maximumUntrackedFileBytes: 2 * 1024 * 1024,
          }),
        )
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to capture snapshot", {
            cause,
            reason: cause.message,
            absolutePathCharacters: gitDirectory.length,
            absolutePathBytes: Buffer.byteLength(gitDirectory),
            relativePathCharacters: path.relative(worktree, gitDirectory).length,
          }).pipe(Effect.as(undefined)),
        ),
      )
    })

    const compare = Effect.fnUntraced(function* (operation: "files" | "diff", input: CompareInput) {
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure(operation, cause)))
      return { repository: repo, from: Git.TreeID.make(input.from), to: Git.TreeID.make(input.to) }
    })

    const files = Effect.fn("Snapshot.files")(function* (input: CompareInput) {
      if (FileBackup.isID(input.from) || FileBackup.isID(input.to))
        return yield* backups.files(input).pipe(Effect.mapError((cause) => failure("files", cause)))
      const comparison = yield* compare("files", input)
      const files = yield* git.tree.files(comparison).pipe(Effect.mapError((cause) => failure("files", cause)))
      if (!source) return files
      const ignored = yield* git.index
        .ignored({ repository: source, paths: files })
        .pipe(Effect.mapError((cause) => failure("files", cause)))
      return files.filter((file) => !ignored.has(file))
    })

    const diff = Effect.fn("Snapshot.diff")(function* (input: DiffInput) {
      if (FileBackup.isID(input.from) || FileBackup.isID(input.to))
        return yield* backups.diff(input).pipe(Effect.mapError((cause) => failure("diff", cause)))
      const comparison = yield* compare("diff", input)
      const files = yield* git.tree.files(comparison).pipe(Effect.mapError((cause) => failure("diff", cause)))
      const ignored = source
        ? yield* git.index
            .ignored({ repository: source, paths: files })
            .pipe(Effect.mapError((cause) => failure("diff", cause)))
        : new Set<RelativePath>()
      return yield* git.tree
        .diff({
          ...comparison,
          context: input.context,
          paths: (input.paths ?? files).filter((file) => !ignored.has(file)),
        })
        .pipe(Effect.mapError((cause) => failure("diff", cause)))
    })

    const plan = Effect.fnUntraced(function* (operation: "preview" | "restore", input: RestoreInput) {
      const files = new Map<RelativePath, Git.TreeID>()
      for (const [file, snapshot] of input.files) {
        const absolute = path.resolve(worktree, file)
        if (!FSUtil.contains(worktree, absolute))
          return yield* new Error({ operation, message: `Path escapes the project: ${file}` })
        files.set(file, Git.TreeID.make(snapshot))
      }
      return files
    })

    const preview = Effect.fn("Snapshot.preview")(function* (input: PreviewInput) {
      if ([...input.files.values()].some(FileBackup.isID)) {
        const plan = yield* backups.restore(input.files).pipe(Effect.mapError((cause) => failure("preview", cause)))
        return yield* Effect.forEach(plan, (item) =>
          Effect.gen(function* () {
            const current = yield* backups.capture(item.sessionID)
            return yield* backups.diff({
              from: current,
              to: input.files.get(item.path)!,
              paths: [item.path],
              context: input.context,
            })
          }).pipe(Effect.mapError((cause) => failure("preview", cause))),
        ).pipe(Effect.map((items) => items.flat()))
      }
      if (!(yield* enabled())) return yield* new Error({ operation: "preview", message: "Snapshots are disabled" })
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("preview", cause)))
      const files = yield* plan("preview", input)
      const current = yield* git.tree
        .capture({
          repository: repo,
          scopes: Array.from(files.keys()),
          ignores: source,
          maximumUntrackedFileBytes: 2 * 1024 * 1024,
        })
        .pipe(Effect.mapError((cause) => failure("preview", cause)))
      return yield* git.tree
        .preview({
          repository: repo,
          current,
          files,
          context: input.context,
        })
        .pipe(Effect.mapError((cause) => failure("preview", cause)))
    })

    const restore = Effect.fn("Snapshot.restore")(function* (input: RestoreInput) {
      if ([...input.files.values()].some(FileBackup.isID)) {
        return yield* Effect.gen(function* () {
          const plan = yield* backups.restore(input.files)
          // Validate every selected path/hash before modifying the first file.
          const prepared = yield* Effect.forEach(plan, (item) =>
            Effect.gen(function* () {
              const target = yield* targets.resolve({ path: item.path, kind: "file" })
              if (target.canonical !== item.target || !FSUtil.contains(location.directory, target.canonical))
                return yield* new FileMutation.TargetChangedError({ path: item.path })
              const bytes = yield* fs
                .readFile(target.canonical)
                .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)))
              if ((bytes === null ? null : FileBackup.hash(bytes)) !== item.expected)
                return yield* new FileMutation.StaleContentError({ path: item.path })
              return { item, target }
            }),
          )
          yield* Effect.forEach(
            prepared,
            ({ item, target }) =>
              mutations.restore({
                ...item,
                validate: Effect.gen(function* () {
                  const current = yield* targets
                    .resolve({ path: item.path, kind: "file" })
                    .pipe(Effect.mapError(() => new FileMutation.TargetChangedError({ path: item.path })))
                  if (current.canonical !== target.canonical || current.identity !== target.identity)
                    return yield* new FileMutation.TargetChangedError({ path: item.path })
                }),
              }),
            { discard: true },
          )
        }).pipe(Effect.mapError((cause) => failure("restore", cause)))
      }
      if (!(yield* enabled())) return yield* new Error({ operation: "restore", message: "Snapshots are disabled" })
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("restore", cause)))
      yield* git.tree
        .restore({ repository: repo, files: yield* plan("restore", input) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    const checkout = Effect.fn("Snapshot.checkout")(function* (snapshot: ID) {
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("restore", cause)))
      yield* git.tree
        .checkout({ repository: repo, tree: Git.TreeID.make(snapshot) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    return Service.of({ capture, files, diff, preview, restore, checkout })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Config.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Config.node,
    FSUtil.node,
    Git.node,
    Global.node,
    Location.node,
    FileBackup.node,
    FileMutation.node,
    LocationMutation.node,
  ],
})

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    capture: () => Effect.succeed(undefined),
    files: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
  }),
)

function failure(operation: Error["operation"], cause: unknown) {
  if (cause instanceof Error && cause.operation === operation) return cause
  return new Error({
    operation,
    message:
      cause instanceof FileMutation.StaleContentError
        ? `Cannot undo ${cause.path}: the file changed after this write. No conflicting file was overwritten.`
        : cause instanceof FileMutation.TargetChangedError
          ? `Cannot undo ${cause.path}: the file or its parent was replaced. No conflicting file was overwritten.`
          : cause instanceof globalThis.Error
            ? cause.message
            : String(cause),
    cause,
  })
}

/** Legacy persisted session diff shape. */
export type LegacyFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}
