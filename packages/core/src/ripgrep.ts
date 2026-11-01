export * as Ripgrep from "./ripgrep"

import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Entry, Match } from "@zaovra-ai/schema/filesystem"
import { makeGlobalNode } from "./effect/app-node"
import { AppProcess, collectStream, waitForAbort } from "./process"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema"
import { RipgrepBinary } from "./ripgrep/binary"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */

const ERROR_BYTES = 8 * 1024
const MAX_RECORD_BYTES = 64 * 1024
const MAX_SUBMATCHES = 100

const RawMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})

type RawMatchData = (typeof RawMatch.Type)["data"]

export class Error extends Schema.TaggedErrorClass<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidPatternError extends Schema.TaggedErrorClass<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: string
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
  readonly globSummary: (input: GlobInput) => Effect.Effect<SearchResult<Entry>, Error>
  readonly grepSummary: (input: GrepInput) => Effect.Effect<SearchResult<Match>, Error | InvalidPatternError>
}

export interface SearchResult<A> {
  readonly items: readonly A[]
  readonly truncated: boolean
  readonly partial: boolean
  readonly skippedRecords: number
}

export class Service extends Context.Service<Service, Interface>()("@zaovra/v2/Ripgrep") {}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    const binary = yield* RipgrepBinary.Service

    const run = <A>(input: {
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly signal?: AbortSignal
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly onItem?: (item: A) => Effect.Effect<void>
    }) => {
      const program = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* process.spawn(
            ChildProcess.make(yield* binary.filepath, input.args, { cwd: input.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          let observed = 0
          let pending = Buffer.alloc(0)
          let dropping = false
          let skippedRecords = 0
          const rows = yield* Stream.concat(handle.stdout, Stream.succeed(Buffer.from("\n"))).pipe(
            Stream.map((chunk) => {
              const lines: string[] = []
              let offset = 0
              while (offset < chunk.length) {
                const newline = chunk.indexOf(10, offset)
                const end = newline === -1 ? chunk.length : newline
                if (!dropping) {
                  if (pending.length + end - offset > MAX_RECORD_BYTES) {
                    skippedRecords++
                    dropping = true
                    pending = Buffer.alloc(0)
                  } else {
                    pending = Buffer.concat([pending, chunk.subarray(offset, end)])
                  }
                }
                if (newline !== -1) {
                  if (!dropping && pending.length > 0) lines.push(pending.toString("utf8"))
                  pending = Buffer.alloc(0)
                  dropping = false
                }
                offset = end + 1
              }
              return lines
            }),
            Stream.flatMap((lines) => Stream.fromIterable(lines)),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              if (!input.onItem || observed++ >= input.limit) return Effect.void
              return input.onItem(row)
            }),
            Stream.take(input.limit + 1),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )
          const truncated = rows.length > input.limit
          if (truncated)
            return { items: rows.slice(0, input.limit), truncated, partial: skippedRecords > 0, skippedRecords }

          const code = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          return {
            items: code === 1 ? [] : rows,
            truncated: false,
            partial: code === 2 || skippedRecords > 0,
            skippedRecords,
          }
        }),
      )
      const abortable = input.signal ? program.pipe(Effect.raceFirst(waitForAbort(input.signal))) : program
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure("ripgrep execution failed", cause),
        ),
      )
    }

    const search = {
      glob: (input: GlobInput) =>
        run<string>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            `--glob=${input.pattern}`,
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) =>
            Effect.succeed(
              line
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/"),
            ),
        }).pipe(
          Effect.map((result) => ({
            ...result,
            items: result.items.map((relative) =>
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            ),
          })),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      find: (input: FindInput) =>
        run<Entry>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) => {
            const relative = line
              .replace(/^(?:\.[\\/])+/u, "")
              .replace(/^[\\/]+/u, "")
              .replaceAll("\\", "/")
            return Effect.succeed(
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            )
          },
          onItem: input.onEntry,
        }).pipe(
          Effect.map((result) => result.items),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      grep: (input: GrepInput) =>
        run<RawMatchData>({
          ...input,
          args: [
            "--no-config",
            "--json",
            "--hidden",
            "--no-messages",
            ...(input.include ? [`--glob=${input.include}`] : []),
            "--glob=!**/.git/**",
            "--",
            input.pattern,
            input.file ?? ".",
          ],
          parse: (line) =>
            Effect.try({
              try: () => JSON.parse(line) as unknown,
              catch: (cause) => failure("Invalid ripgrep JSON output", cause),
            }).pipe(
              Effect.flatMap((json) => {
                if (!json || typeof json !== "object" || !("type" in json) || json.type !== "match")
                  return Effect.succeed(undefined)
                return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                  Effect.map((match) => ({
                    ...match.data,
                    path: { text: match.data.path.text.replace(/^\.[\\/]/, "") },
                    submatches: match.data.submatches.slice(0, MAX_SUBMATCHES),
                  })),
                  Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
                )
              }),
            ),
        }).pipe(
          Effect.map((result) => ({
            ...result,
            items: result.items.map((match) => {
              const relative = match.path.text
                .replace(/^(?:\.[\\/])+/u, "")
                .replace(/^[\\/]+/u, "")
                .replaceAll("\\", "/")
              return Match.make({
                entry: Entry.make({
                  path: RelativePath.make(relative),
                  type: "file",
                }),
                line: match.line_number,
                offset: match.absolute_offset,
                text: match.lines.text.length > 2_000 ? match.lines.text.slice(0, 2_000) + "..." : match.lines.text,
                submatches: match.submatches.map((submatch) => ({
                  text: submatch.match.text,
                  start: submatch.start,
                  end: submatch.end,
                })),
              })
            }),
          })),
        ),
    }
    return Service.of({
      find: search.find,
      glob: (input) => search.glob(input).pipe(Effect.map((result) => result.items)),
      grep: (input) => search.grep(input).pipe(Effect.map((result) => result.items)),
      globSummary: search.glob,
      grepSummary: search.grep,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [RipgrepBinary.node, AppProcess.node] })
