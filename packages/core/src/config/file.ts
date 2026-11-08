export * as ConfigFile from "./file"

import path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { Flock } from "../util/flock"

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("ConfigWriteConflict", {
  path: Schema.String,
}) {
  override get message() {
    return `Configuration changed while saving: ${this.path}. Reload Settings and try again.`
  }
}

function key(file: string) {
  const resolved = FSUtil.resolve(path.join(FSUtil.resolve(path.dirname(file)), path.basename(file)))
  return {
    key: "config:" + (process.platform === "win32" ? resolved.toLowerCase() : resolved),
    dir: path.dirname(resolved),
  }
}

/** All application config writers share this cross-process, canonical-path lock. */
export function withLock<A, E, R>(file: string, body: Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const lock = key(file)
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: (signal) => Flock.acquire(lock.key, { dir: lock.dir, signal }),
          catch: (cause) => new FSUtil.FileSystemError({ method: "config.lock", cause }),
        }),
        (lease) => Effect.promise(() => lease.release()),
      )
      return yield* body
    }),
  )
}

export function withLockPromise<A>(file: string, body: () => Promise<A>) {
  const lock = key(file)
  return Flock.withLock(lock.key, body, { dir: lock.dir })
}

export function update<E, R>(
  fs: FSUtil.Interface,
  file: string,
  edit: (text: string | undefined) => Effect.Effect<string | undefined, E, R>,
) {
  return withLock(
    file,
    Effect.gen(function* () {
      const read = fs
        .readFileString(file)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
      const before = yield* read
      const next = yield* edit(before)
      if (next === undefined || next === before) return { before, text: before, changed: false }
      // Detect completed non-cooperating edits. This check is not a filesystem CAS;
      // arbitrary editors that ignore the lock can still race the subsequent write.
      if ((yield* read) !== before) return yield* new ConflictError({ path: file })
      yield* fs.writeFileString(file, next)
      return { before, text: next, changed: true }
    }),
  )
}
