export * as GrepTool from "./grep"

import { ToolFailure } from "@zaovra-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { safetyFailure } from "./safety-failure"

export const name = "grep"

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern.annotate({
    description: "Regex pattern to search for in file contents",
  }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description:
      "File or directory to search. Relative paths stay in the active Location; external absolute paths require external_directory approval.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'File glob to include in the search (for example, "*.js" or "*.{ts,tsx}")',
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: "Maximum matches to return (default 100). Narrow the search if incomplete.",
  }),
})

export const Output = Schema.Struct({
  matches: Schema.Array(FileSystem.Match),
  truncated: Schema.Boolean,
  partial: Schema.Boolean,
  skippedRecords: Schema.Number,
})
type ModelOutput = typeof Output.Encoded

/** Format raw search matches into the familiar concise model output. */
export const toModelOutput = (output: ModelOutput) => {
  const lines =
    output.matches.length === 0 && !output.partial ? ["No files found"] : [`Found ${output.matches.length} matches`]
  let current = ""
  for (const match of output.matches) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  if (output.truncated) lines.push("Result limit reached; narrow the path/pattern or set an explicit limit.")
  if (output.partial)
    lines.push(
      `Partial search: ${output.skippedRecords} overlong records skipped; some files or records may be missing. Narrow the search and read relevant files.`,
    )
  return lines.join("\n")
}

/** Grep leaf that defaults its filesystem root to the active Location. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const mutation = yield* LocationMutation.Service

    yield* tools
      .register({
        [name]: Tool.make({
          observation: true,
          description:
            "Search file contents by regular expression within the active Location or a separately approved external absolute path. Use a path to narrow the search, include to filter files by glob, and limit to bound the match count. Returns concise file resources, line numbers, and bounded line previews.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutput({
                ...output,
                matches: output.matches.map((match) => ({
                  ...match,
                  entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
                })),
              }),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.path ?? ".", kind: "directory" })
              if (target.externalDirectory)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: ".",
                  path: input.path,
                  include: input.include,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const current = yield* mutation.resolve({ path: input.path ?? ".", kind: "directory" })
              if (
                current.canonical !== target.canonical ||
                current.resource !== target.resource ||
                (current.identity &&
                  target.identity &&
                  LocationMutation.identityKey(current.identity) !== LocationMutation.identityKey(target.identity))
              )
                return yield* new ToolFailure({
                  message:
                    "Search target changed during permission approval. Resolve the path and request permission again.",
                })
              const info = yield* fs.stat(target.canonical)
              if (info.type !== "Directory" && info.type !== "File")
                return yield* new ToolFailure({ message: "Search target must be a regular file or directory." })
              return yield* ripgrep
                .grepSummary({
                  cwd: info.type === "Directory" ? target.canonical : path.dirname(target.canonical),
                  pattern: input.pattern,
                  file: info.type === "File" ? path.basename(target.canonical) : undefined,
                  include: input.include,
                  limit: input.limit ?? 100,
                })
                .pipe(
                  Effect.map((result) => ({
                    truncated: result.truncated,
                    partial: result.partial,
                    skippedRecords: result.skippedRecords,
                    matches: result.items.map((match) =>
                      FileSystem.Match.make({
                        ...match,
                        entry: FileSystem.Entry.make({
                          ...match.entry,
                          path: RelativePath.make(
                            path.relative(
                              location.directory,
                              path.resolve(
                                info.type === "Directory" ? target.canonical : path.dirname(target.canonical),
                                match.entry.path,
                              ),
                            ),
                          ),
                        }),
                      }),
                    ),
                  })),
                )
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : (safetyFailure(error) ?? new ToolFailure({ message: `Unable to grep for ${input.pattern}` })),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/grep",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, Ripgrep.node, Location.node, PermissionV2.node, LocationMutation.node],
})
