export * as LocationMutation from "./location-mutation"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema, Option } from "effect"
import { FSUtil } from "./fs-util"
import { Location } from "./location"

export const Kind = Schema.Literals(["file", "directory"])
export type Kind = typeof Kind.Type

/**
 * Mutation paths do not accept project references. Relative paths must stay
 * inside the active Location. Absolute paths outside it require separate
 * `external_directory` approval.
 */
export const ResolveInput = Schema.Struct({
  path: Schema.String,
  /** Selects the external approval boundary; it does not validate the target type. */
  kind: Kind.pipe(Schema.optional),
})
export type ResolveInput = typeof ResolveInput.Type

export class PathError extends Schema.TaggedErrorClass<PathError>()("LocationMutation.PathError", {
  path: Schema.String,
  reason: Schema.Literals(["relative_escape", "location_escape", "non_directory_ancestor"]),
}) {}

export interface ExternalDirectoryAuthorization {
  readonly action: "external_directory"
  /** Canonical existing directory used as the external approval boundary. */
  readonly directory: string
  /** `external_directory` permission resource. */
  readonly resource: string
  readonly save: string
}

export const externalDirectoryPermission = (input: ExternalDirectoryAuthorization) => ({
  action: input.action,
  resources: [input.resource],
  save: [input.save],
})

export interface Target {
  /** Identity of the resolved object and its existing directory at approval time. */
  readonly identity?: string
  /** Canonical existing path, or missing path below a canonical directory. */
  readonly canonical: string
  /** Permission resource: Location-relative for internal paths, canonical for external paths. */
  readonly resource: string
  readonly externalDirectory?: ExternalDirectoryAuthorization
}

export interface Interface {
  /**
   * Resolve a path and derive its permission resources. Relative paths must
   * stay inside the Location. Absolute paths outside it require separate
   * `external_directory` approval. This does not approve the mutation.
   */
  readonly resolve: (input: ResolveInput) => Effect.Effect<Target, PathError | FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/v2/LocationMutation") {}

/** Available only while FileMutation holds the approved file and parent open. */
export class PinnedIdentity extends Context.Service<
  PinnedIdentity,
  { canonical: string; identity: string; key: string }
>()("@zaovra/LocationMutation/PinnedIdentity") {}

const Identity = Schema.Tuple([
  Schema.String,
  Schema.Number,
  Schema.NullOr(Schema.Number),
  Schema.Unknown,
  Schema.NullOr(Schema.Tuple([Schema.Number, Schema.NullOr(Schema.Number), Schema.Unknown])),
])
export function identityKey(identity: string) {
  const value = Schema.decodeUnknownSync(Schema.fromJsonString(Identity))(identity)
  return JSON.stringify([value[0], value[1], value[2], value[4] && [value[4][0], value[4][1]]])
}

interface ResolvedPath {
  readonly canonical: string
  readonly type?:
    | "File"
    | "Directory"
    | "SymbolicLink"
    | "BlockDevice"
    | "CharacterDevice"
    | "FIFO"
    | "Socket"
    | "Unknown"
  readonly directory: string
}

const slash = (value: string) => value.replaceAll("\\", "/")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const root = yield* Effect.cached(fs.realPath(location.directory))

    function notFound<A>(effect: Effect.Effect<A, FSUtil.Error>) {
      return effect.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
    }

    const resolvePath = Effect.fnUntraced(function* (absolute: string) {
      const existing = yield* notFound(fs.realPath(absolute))
      if (existing !== undefined) {
        const info = yield* fs.stat(existing)
        return {
          canonical: existing,
          type: info.type,
          directory: info.type === "Directory" ? existing : path.dirname(existing),
        } satisfies ResolvedPath
      }

      let anchor = path.dirname(absolute)
      while (true) {
        const canonical = yield* notFound(fs.realPath(anchor))
        if (canonical !== undefined) {
          const info = yield* fs.stat(canonical)
          if (info.type !== "Directory") {
            return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
          }
          return {
            canonical: path.resolve(canonical, path.relative(anchor, absolute)),
            directory: canonical,
          } satisfies ResolvedPath
        }
        const parent = path.dirname(anchor)
        if (parent === anchor) return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
        anchor = parent
      }
    })

    const resolve = Effect.fn("LocationMutation.resolve")(function* (input: ResolveInput) {
      const locationRoot = yield* root
      const relative = !path.isAbsolute(input.path)
      const absolute = path.resolve(location.directory, input.path)
      const lexicallyInternal = FSUtil.contains(location.directory, absolute)
      if (relative && !lexicallyInternal) return yield* new PathError({ path: input.path, reason: "relative_escape" })

      const resolved = yield* resolvePath(absolute)
      if (lexicallyInternal && !FSUtil.contains(locationRoot, resolved.canonical)) {
        return yield* new PathError({ path: input.path, reason: "location_escape" })
      }

      const external = !lexicallyInternal
      const resource = external
        ? slash(resolved.canonical)
        : slash(path.relative(locationRoot, resolved.canonical) || ".")
      const externalDirectory =
        input.kind === "directory" && resolved.type === "Directory" ? resolved.canonical : resolved.directory
      const externalResource = slash(path.join(externalDirectory, "*"))
      const directoryIdentity = yield* fs.stat(resolved.directory)
      const fileIdentity = resolved.type === "File" ? yield* fs.stat(resolved.canonical) : undefined
      const identity = JSON.stringify([
        resolved.directory,
        directoryIdentity.dev,
        Option.getOrNull(directoryIdentity.ino),
        Option.getOrNull(directoryIdentity.birthtime),
        fileIdentity
          ? [fileIdentity.dev, Option.getOrNull(fileIdentity.ino), Option.getOrNull(fileIdentity.birthtime)]
          : null,
      ])
      const pinned = Option.getOrUndefined(yield* Effect.serviceOption(PinnedIdentity))
      return {
        // Overlay copy-up changes btime while preserving the pinned object. A
        // different inode, parent, canonical path or permission resource still fails.
        identity:
          pinned?.canonical === resolved.canonical && pinned.key === identityKey(identity) ? pinned.identity : identity,
        canonical: resolved.canonical,
        resource,
        externalDirectory: external
          ? {
              action: "external_directory",
              directory: externalDirectory,
              resource: externalResource,
              save: externalResource,
            }
          : undefined,
      } satisfies Target
    })

    return Service.of({ resolve })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [FSUtil.node, Location.node],
})
