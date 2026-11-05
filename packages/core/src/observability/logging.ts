import { Effect, Exit, Formatter, Layer, Logger, Scope, type LogLevel } from "effect"
import path from "path"
import { Global } from "../global"
import { ProcessTree } from "../process-tree"
import { runID } from "./shared"

function formatter(id: string = runID) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ")
  })
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

export function fileLogger(file = path.join(Global.Path.log, "zaovra.log"), id: string = runID) {
  // Do not set batchWindow to 0; it causes high idle CPU usage.
  return Effect.gen(function* () {
    const scope = yield* Scope.make()
    let closing: Promise<void> | undefined
    const close = () => (closing ??= Effect.runPromise(Scope.close(scope, Exit.void)))
    const remove = ProcessTree.onForceExit(close)
    // Keep the drain registered while normal scope disposal is in flight, so a
    // concurrent second signal joins that same drain instead of skipping it.
    yield* Effect.addFinalizer(() => Effect.promise(close).pipe(Effect.ensuring(Effect.sync(remove))))
    return yield* Logger.toFile(formatter(id), file, { flag: "a" }).pipe(Scope.provide(scope))
  })
}

export const processTreeEvents = Layer.effectDiscard(
  Effect.gen(function* () {
    // Capture the configured logger instead of using a default console logger in the callback.
    const runSync = Effect.runSyncWith(yield* Effect.context<never>())
    const report = (cleanup: ProcessTree.Cleanup) =>
      runSync(Effect.logInfo({ message: "cleanup unverified", ...cleanup }))
    yield* Effect.acquireRelease(
      Effect.sync(() => ProcessTree.events.on("cleanup", report)),
      () => Effect.sync(() => ProcessTree.events.off("cleanup", report)),
    )
  }),
)

const stderrLogger = Logger.make((options) => process.stderr.write(formatter().log(options) + "\n"))

export function minimumLogLevel() {
  const value = process.env.ZAOVRA_LOG_LEVEL?.toUpperCase()
  const levels = {
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>
  return value && value in levels ? levels[value as keyof typeof levels] : levels.INFO
}

export function loggers() {
  return process.env.ZAOVRA_PRINT_LOGS === "1" ? [fileLogger(), stderrLogger] : [fileLogger()]
}

export * as Logging from "./logging"
